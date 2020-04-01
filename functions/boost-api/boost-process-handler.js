'use strict';

const logger = require('debug')('jupiter:boosts:handler');
// const config = require('config');

const status = require('statuses');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const publisher = require('publish-common');

const GAME_RESPONSE = 'GAME_RESPONSE';

const handleError = (err) => {
    logger('FATAL_ERROR: ', err);
    return { statusCode: status('Internal Server Error'), body: JSON.stringify(err.message) };
};

// //////////////////////////// HELPER METHODS ///////////////////////////////////////////

// this takes the event and creates the arguments to pass to persistence to get applicable boosts, i.e.,
// those that still have budget remaining and are in offered or pending state for this user
const extractFindBoostKey = (event) => {
    const persistenceKey = event.accountId ? { accountId: [event.accountId] } : { userId: [event.userId] };
    persistenceKey.boostStatus = util.ACTIVE_BOOST_STATUS;
    persistenceKey.active = true;
    persistenceKey.underBudgetOnly = true;
    return persistenceKey;
};

const shouldCreateBoostForAccount = (event, boost) => {
    const statusConditions = boost.statusConditions;
    logger('Got status conditions:', statusConditions);
    
    // To guard against accidentally redeeming a boost to all and sundry, check statuses except for REDEEMED
    const statusesToCheck = Object.keys(statusConditions).filter((statusCondition) => statusCondition !== 'REDEEMED');
    return statusesToCheck.some((statusCondition) => conditionTester.testCondition(event, statusConditions[statusCondition][0]));
};

const extractPendingAccountsAndUserIds = async (initiatingAccountId, boosts) => {
    const selectPromises = boosts.map((boost) => {
        const redeemsAll = boost.flags && boost.flags.indexOf('REDEEM_ALL_AT_ONCE') >= 0;
        const restrictToInitiator = boost.boostAudienceType === 'GENERAL' || !redeemsAll;
        const findAccountsParams = { boostIds: [boost.boostId], status: util.ACTIVE_BOOST_STATUS };
        if (restrictToInitiator) {
            findAccountsParams.accountIds = [initiatingAccountId];
        }
        logger('Assembled params: ', findAccountsParams);
        try {
            return persistence.findAccountsForBoost(findAccountsParams);
        } catch (err) {
            logger('FATAL_ERROR:', err);
            return { };
        }
    });

    const affectedAccountArray = await Promise.all(selectPromises);
    logger('Affected accounts: ', affectedAccountArray);
    return affectedAccountArray.map((result) => result[0]).
        reduce((obj, item) => ({ ...obj, [item.boostId]: item.accountUserMap }), {});
};

// //////////////////////////// PRIMARY METHODS ///////////////////////////////////////////

const createBoostsTriggeredByEvent = async (event) => {
    const { accountId } = event;

    // select all boosts that are active, but not present in the user-boost table for this user/account
    const boostFetchResult = await persistence.fetchUncreatedActiveBoostsForAccount(accountId);
    logger('Found active boosts:', boostFetchResult);

    // Then check the status conditions until finding one that is triggered by this event
    const boostsToCreate = boostFetchResult.filter((boost) => shouldCreateBoostForAccount(event, boost)).map((boost) => boost.boostId);
    logger('Boosts to create:', boostsToCreate);
    if (boostsToCreate.length === 0) {
        return 'NO_BOOSTS_CREATED';
    }

    return persistence.insertBoostAccount(boostsToCreate, accountId, 'CREATED');
};

const generateUpdateInstructions = (alteredBoosts, boostStatusChangeDict, affectedAccountsUsersDict, transactionId) => {
    logger('Generating update instructions, with affected accounts map: ', affectedAccountsUsersDict);
    return alteredBoosts.map((boost) => {
        const boostId = boost.boostId;
        const boostStatusSorted = boostStatusChangeDict[boostId].sort(util.statusSorter);
        const highestStatus = boostStatusSorted[0];
        const isChangeRedemption = highestStatus === 'REDEEMED';
        const appliesToAll = boost.flags && boost.flags.indexOf('REDEEM_ALL_AT_ONCE') >= 0;
        const logContext = { newStatus: highestStatus, boostAmount: boost.boostAmount };
        if (transactionId) {
            logContext.transactionId = transactionId;
        }

        return {
            boostId,
            accountIds: Object.keys(affectedAccountsUsersDict[boostId]),
            newStatus: highestStatus,
            stillActive: !(isChangeRedemption && appliesToAll),
            logType: 'STATUS_CHANGE',
            logContext
        };
    });
};

const processEventForCreatedBoosts = async (event) => {
    const offeredOrPendingBoosts = await persistence.findBoost(extractFindBoostKey(event));
    logger('Found these open boosts: ', offeredOrPendingBoosts);

    if (!offeredOrPendingBoosts || offeredOrPendingBoosts.length === 0) {
        logger('Well, nothing found');
        return { statusCode: status('Ok'), body: JSON.stringify({ boostsTriggered: 0 })};
    }

    // for each offered or pending boost, we check if the event triggers a status change, and hence compose an object
    // whose keys are the boost IDs and whose values are the lists of statuses whose conditions have been met
    const boostStatusChangeDict = { };
    offeredOrPendingBoosts.forEach((boost) => {
        boostStatusChangeDict[boost.boostId] = conditionTester.extractStatusChangesMet(event, boost);
    });
    logger('Status change dict: ', boostStatusChangeDict);
    
    const boostsForStatusChange = offeredOrPendingBoosts.filter((boost) => boostStatusChangeDict[boost.boostId].length !== 0);
    // logger('These boosts were triggered: ', boostsForStatusChange);

    if (!boostsForStatusChange || boostsForStatusChange.length === 0) {
        logger('Boosts found, but none triggered to change, so exiting');
        return { boostsTriggered: 0 };
    }

    logger('At least one boost was triggered. First step is to extract affected accounts, then tell the float to transfer from bonus pool');
    // note : this is in the form, top level keys: boostID, which gives a dict, whose own key is the account ID, and an object with userId and status
    const affectedAccountsDict = await extractPendingAccountsAndUserIds(event.accountId, boostsForStatusChange);
    logger('Retrieved affected accounts and user IDs: ', affectedAccountsDict);

    // then we update the statuses of the boosts to redeemed
    const transactionId = event.eventContext ? event.eventContext.transactionId : null;
    const updateInstructions = generateUpdateInstructions(boostsForStatusChange, boostStatusChangeDict, affectedAccountsDict, transactionId);
    logger('Sending these update instructions to persistence: ', updateInstructions);

    // first, do the float allocations. we do not parallel process this as if it goes wrong we should not proceed
    const boostsToRedeem = boostsForStatusChange.filter((boost) => boostStatusChangeDict[boost.boostId].indexOf('REDEEMED') >= 0);
    // then we also check for withdrawal boosts
    const boostsToRevoke = boostsForStatusChange.filter((boost) => boostStatusChangeDict[boost.boostId].indexOf('REVOKED') >= 0);

    let resultOfTransfers = [];
    if (boostsToRedeem.length > 0 || boostsToRevoke.length > 0) {
        const redemptionCall = { redemptionBoosts: boostsToRedeem, revocationBoosts: boostsToRevoke, affectedAccountsDict: affectedAccountsDict, event };
        resultOfTransfers = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
    }

    // a little ugly with the repeat if statements, but we want to make sure if the redemption call fails, the user is not updated to redeemed spuriously 
    const resultOfUpdates = await persistence.updateBoostAccountStatus(updateInstructions);
    logger('Result of update operation: ', resultOfUpdates);

    if (resultOfTransfers.length > 0) {
        // could do this inside boost redemption handler, but then have to give it persistence connection, and not worth solving that now
        const boostsToUpdateRedemption = [...util.extractBoostIds(boostsToRedeem), ...util.extractBoostIds(boostsToRevoke)];
        persistence.updateBoostAmountRedeemed(boostsToUpdateRedemption);        
    }

    return {
        result: 'SUCCESS',
        resultOfTransfers,
        resultOfUpdates
    };
};

const checkIfAccountWinsTournament = (accountId, redemptionConditions, boostLogs) => {
    const eventContext = { accountTapList: boostLogs };
    const event = { eventType: 'BOOST_EXPIRED', accountId, eventContext };
    return conditionTester.testConditionsForStatus(event, redemptionConditions);
};

const sortAndRankBestScores = (boostGameLogs, accountIds) => {
    // first, create a map that has the unique highest score
    const highScoreMap = new Map();
    boostGameLogs.forEach((log) => {
        const { accountId, logContext } = log;
        const { numberTaps } = logContext; // todo : remove ones over time
        if (!highScoreMap.has(accountId) || highScoreMap.get(accountId) < numberTaps) {
            highScoreMap.set(accountId, numberTaps);
        }
    });

    logger('High score map: ', highScoreMap);
    // eslint-disable-next-line id-length
    const sortedEntries = [...highScoreMap.values()].sort((a, b) => b - a);
    logger('Entry scores, sorted: ', sortedEntries);

    const getAccountIdRanking = (accountId) => ({ 
        numberTaps: highScoreMap.get(accountId), 
        ranking: sortedEntries.indexOf(highScoreMap.get(accountId)) + 1 
    });

    return accountIds.reduce((obj, accountId) => ({ ...obj, [accountId]: getAccountIdRanking(accountId) }), {});
};

const generateRedemptionAccountMap = async (boostId, winningAccounts) => {
    const findAccountParams = { boostIds: [boostId], accountIds: winningAccounts, status: util.ACTIVE_BOOST_STATUS };
    const accountInfo = await persistence.findAccountsForBoost(findAccountParams);

    return { [boostId]: accountInfo[0].accountUserMap };
};

const expireAccountsForBoost = async (boostId, specifiedAccountIds) => {
    const accountIds = specifiedAccountIds || null; // null makes it all of them
    const accountsToExpire = await persistence.findAccountsForBoost({ boostIds: [boostId], status: util.ACTIVE_BOOST_STATUS, accountIds });
    const accountMap = accountsToExpire[0].accountUserMap;
    
    const updateInstruction = { boostId, newStatus: 'EXPIRED', accountIds: Object.keys(accountMap) };
    const resultOfExpiration = await persistence.updateBoostAccountStatus([updateInstruction]);
    logger('Result of expiring boosts: ', resultOfExpiration);

    const userIds = [...new Set(Object.values(accountMap).map((entry) => entry.userId))];
    publisher.publishMultiUserEvent(userIds, 'BOOST_EXPIRED', { context: { boostId }});
};

const handleExpiredBoost = async (boostId) => {
    const [boost, boostGameLogs] = await Promise.all([persistence.fetchBoost(boostId), persistence.findLogsForBoost(boostId, GAME_RESPONSE)]);
    logger('Processing boost for expiry: ', boost);

    if (boost.boostType !== 'GAME' || !boostGameLogs) {
        // just expire the boosts and be done
        await expireAccountsForBoost(boostId);
        return { resultCode: 200, body: 'Not a game, or no responses' };
    }

    const { statusConditions } = boost;
    if (!statusConditions || !statusConditions.REDEEMED) {
        await expireAccountsForBoost(boostId);
        return { resultCode: 200, body: 'No redemption condition' };
    }
    
    const accountIds = [...new Set(boostGameLogs.map((log) => log.accountId))];
    logger('Account IDs with responses: ', accountIds);

    // not the most efficient thing in the world, but it will not happen often, and we can optimize later
    const winningAccounts = accountIds.filter((accountId) => checkIfAccountWinsTournament(accountId, statusConditions.REDEEMED, boostGameLogs));
    if (winningAccounts.length > 0) {
        const redemptionAccountDict = await generateRedemptionAccountMap(boostId, winningAccounts);
        logger('Redemption account dict: ', redemptionAccountDict);
        const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId };
        const redemptionCall = { redemptionBoosts: [boost], affectedAccountsDict: redemptionAccountDict, event: redemptionEvent };
        const resultOfRedemptions = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
        logger('Result of redemptions for winners: ', resultOfRedemptions);
        const redemptionUpdate = { boostId, accountIds: winningAccounts, logType: 'STATUS_CHANGE', newStatus: 'REDEEMED' };
        const resultOfRedeemUpdate = await persistence.updateBoostAccountStatus([redemptionUpdate]);
        logger('And result of redemption account update: ', resultOfRedeemUpdate);
        const winningUserIds = Object.values(redemptionAccountDict[boostId]).map((entry) => entry.userId);
        await publisher.publishMultiUserEvent(winningUserIds, 'BOOST_TOURNAMENT_WON', { context: { boostId }});
    }

    const remainingAccounts = accountIds.filter((accountId) => !winningAccounts.includes(accountId));
    logger('Will expire these remaining accounts: ', remainingAccounts);
    const resultOfUpdate = await expireAccountsForBoost(boostId, remainingAccounts);
    logger('Result of expiry update: ', resultOfUpdate);

    // as above, inefficient, but to neaten up later
    const sortedAndRankedAccounts = sortAndRankBestScores(boostGameLogs, accountIds);
    logger('Sorted and ranked accounts: ', sortedAndRankedAccounts); 
    const resultLogs = accountIds.map((accountId) => ({
        boostId,
        accountId,
        logType: 'GAME_OUTCOME',
        logContext: sortedAndRankedAccounts[accountId]
    }));
    const resultOfLogInsertion = await persistence.insertBoostAccountLogs(resultLogs);
    logger('Finally, result of log insertion: ', resultOfLogInsertion);

    return { statusCode: 200, boostsRedeemed: winningAccounts.length };
};

/**
 * Generic handler for any boost relevant response (add cash, solve game, etc)
 * Note: at present, since we handle a relatively limited range of events, this gets directly invoked,
 * though in future we may put it onto the same SNS topic as message process and event handler
 * @param {object} event An event object containing the request context and request body.
 * @property {string} userId The users id.
 * @property {string} accountId The account id. Either the user id or the account id must be provided.
 */
module.exports.processEvent = async (event) => {
    logger('Processing boost event: ', event);

    if (event.eventType === 'BOOST_EXPIRED' && event.boostId) {
        return handleExpiredBoost(event.boostId);        
    }

    // second, we check if there is a pending boost for this account, or user, if we only have that
    if (!event.accountId && !event.userId) {
        return { statusCode: status('Bad request'), body: 'Function requires at least a user ID or accountID' };
    }

    if (!event.accountId) {
        // eslint-disable-next-line require-atomic-updates
        event.accountId = await persistence.getAccountIdForUser(event.userId);
    }

    // third, find boosts that do not already have an entry for this user, and are created by this event
    const creationResult = await createBoostsTriggeredByEvent(event);
    logger('Result of boost-account creation creation:', creationResult);

    const resultToReturn = await processEventForCreatedBoosts(event);

    return {
        statusCode: 200,
        body: JSON.stringify(resultToReturn)
    };
};

/**
 * @param {object} event The event from API GW. Contains a body with the parameters:
 * @property {number} numberTaps The number of taps (if a boost game)
 * @property {number} timeTaken The amount of time taken to complete the game (in seconds)  
 */
module.exports.processUserBoostResponse = async (event) => {
    try {        
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: status('Forbidden') };
        }

        const params = util.extractEventBody(event);
        logger('Event params: ', params);

        const { systemWideUserId } = userDetails;
        const { boostId, eventType } = params;

        // todo : make sure boost is available for this account ID
        const [boost, accountId] = await Promise.all([
            persistence.fetchBoost(boostId), 
            persistence.getAccountIdForUser(systemWideUserId)
        ]);

        logger('Fetched boost: ', boost);

        const statusEvent = { eventType, eventContext: params };
        const statusResult = conditionTester.extractStatusChangesMet(statusEvent, boost);

        if (boost.boostType === 'GAME' && eventType === 'USER_GAME_COMPLETION') {
            const gameLogContext = { numberTaps: params.numberTaps, timeTakenInMillis: params.timeTakenMillis };
            const boostLog = { boostId: boost.boostId, accountId, logType: 'GAME_RESPONSE', logContext: gameLogContext };
            await persistence.insertBoostAccountLogs([boostLog]);            
        }
        
        if (statusResult.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ result: 'NO_CHANGE' })};
        }

        const accountDict = { [boostId]: { [accountId]: systemWideUserId }};
        const boostStatusDict = { [boostId]: statusResult };

        const resultBody = { result: 'TRIGGERED', statusMet: statusResult };

        let resultOfTransfer = {};
        if (statusResult.includes('REDEEMED')) {
            // do this first, as if it fails, we do not want to proceed
            const redemptionCall = { redemptionBoosts: [boost], affectedAccountsDict: accountDict, event: { accountId, eventType }};
            resultOfTransfer = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
            logger('Boost process-redemption, result of transfer: ', resultOfTransfer);
        }

        if (resultOfTransfer[boostId] && resultOfTransfer[boostId].result !== 'SUCCESS') {
            throw Error('Error transferring redemption');
        }

        const updateInstructions = generateUpdateInstructions([boost], boostStatusDict, accountDict);
        logger('Sending this update instruction to persistence: ', updateInstructions);
        
        const adjustedLogContext = { ...updateInstructions[0].logContext, processType: 'USER', submittedParams: params };
        updateInstructions[0].logContext = adjustedLogContext;
        const resultOfUpdates = await persistence.updateBoostAccountStatus(updateInstructions);
        logger('Result of update operation: ', resultOfUpdates);
   
        if (statusResult.includes('REDEEMED')) {
            resultBody.amountAllocated = { amount: boost.boostAmount, unit: boost.boostUnit, currency: boost.boostCurrency };
            await persistence.updateBoostAmountRedeemed([boostId]);
        }

        return {
            statusCode: 200,
            body: JSON.stringify(resultBody)
        };
        
    } catch (err) {
        return handleError(err);
    }
};
