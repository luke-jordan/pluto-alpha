'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');

const statusCodes = require('statuses');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const GAME_RESPONSE = 'GAME_RESPONSE';

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
    // then to avoid false positives, strip these down to only the ones triggered by events
    const statusesToCheck = Object.keys(statusConditions).filter((status) => status !== 'REDEEMED').
        filter((status) => statusConditions[status][0] && statusConditions[status][0].startsWith('event_occurs'));
    return statusesToCheck.some((statusCondition) => conditionTester.testCondition(event, statusConditions[statusCondition][0]));
};

const extractPendingAccountsAndUserIds = async (initiatingAccountId, boosts) => {
    logger('Initiating account ID: ', initiatingAccountId);
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
    const { userId, accountId } = event;

    // select all boosts that are active, but not present in the user-boost table for this user/account
    const boostFetchResult = await persistence.fetchUncreatedActiveBoostsForAccount(accountId);
    // logger('Found active boosts:', boostFetchResult);

    // Then check the status conditions until finding one that is triggered by this event
    const boostsToCreate = boostFetchResult.filter((boost) => shouldCreateBoostForAccount(event, boost));
    
    const boostToCreateIds = boostsToCreate.map((boost) => boost.boostId);
    logger('Boosts to create:', boostToCreateIds);
    if (boostsToCreate.length === 0) {
        return 'NO_BOOSTS_CREATED';
    }

    const persistedResult = await persistence.insertBoostAccountJoins(boostToCreateIds, [accountId], 'CREATED');
    const logPublication = boostsToCreate.map((boost) => {
        const logContext = util.constructBoostContext(boost);
        return publisher.publishUserEvent(userId, `BOOST_CREATED_${boost.boostType}`, { context: logContext });
    });
    await Promise.all(logPublication);

    return persistedResult;
};

const fetchAccountIdsForPooledRewards = async (redemptionBoosts) => {
    logger('Fetching account IDs for pooled rewards');
    const boostsWithPooledReward = redemptionBoosts.filter((boost) => boost.rewardParameters &&
        boost.rewardParameters.rewardType === 'POOLED');
    logger('Boosts with pooled rewards: ', boostsWithPooledReward);

    if (boostsWithPooledReward.length === 0) {
        logger('No boosts with pooled rewards, exiting');
        return [];
    }

    const boostIds = boostsWithPooledReward.map((boost) => boost.boostId);
    // todo: reduce to one call to persistence
    const pooledContributionPromises = boostIds.map((boostId) => persistence.findAccountsForPooledReward(boostId, 'BOOST_POOL_CONTRIBUTION'));
    const resultOfFetch = await Promise.all(pooledContributionPromises);
    logger('Fetching pooled rewards, result from persistence:', resultOfFetch);
    const pooledContributionMap = resultOfFetch.reduce((obj, result) => ({ ...obj, [result.boostId]: result.accountIds }), {});
    return pooledContributionMap;
};

// as we do not want to block anything just because of this, but until live for a while, not wholly confident re format of incoming
// note : this is used for yield calculations later
const safeExtractWholeCurrencyAmount = (savedAmount) => {
    try {
        const amountDict = opsUtil.convertAmountStringToDict(savedAmount);
        return opsUtil.convertToUnit(amountDict.amount, amountDict.unit, 'WHOLE_CURRENCY');
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return 0;
    }
};

const generateUpdateInstructions = (alteredBoosts, boostStatusChangeDict, affectedAccountsUsersDict, logContextBase = {}) => {
    logger('Generating update instructions, with affected accounts map: ', affectedAccountsUsersDict);
    return alteredBoosts.map((boost) => {
        const boostId = boost.boostId;
        const boostStatusSorted = boostStatusChangeDict[boostId].sort(util.statusSorter);
        
        const highestStatus = boostStatusSorted[0];
        // see notes elsewhere about side-effects of premature over-parallelization, and its lingering effects;
        // to straighten out and make more comprehensible as soon as time permits
        const thisBoostAccountMap = affectedAccountsUsersDict[boostId];
        const allPriorStatus = [...new Set(Object.values(thisBoostAccountMap).map(({ status }) => status))];
        const priorStatus = allPriorStatus.length === 1 ? allPriorStatus[0] : 'MIXED';
        
        const isChangeRedemption = highestStatus === 'REDEEMED';
        const appliesToAll = boost.flags && boost.flags.indexOf('REDEEM_ALL_AT_ONCE') >= 0;

        const logContext = { newStatus: highestStatus, oldStatus: priorStatus, boostAmount: boost.boostAmount };
        const { transactionId, savedAmount, transferResults } = logContextBase;
        if (transactionId) {
            logContext.transactionId = transactionId;
        }

        // next two so we can start to caculate boost yields much more easily
        if (savedAmount) {
            logContext.savedAmount = savedAmount;
            logContext.savedWholeCurrency = safeExtractWholeCurrencyAmount(savedAmount);
        }

        if (transferResults && transferResults[boostId]) {
            logContext.boostAmount = transferResults[boostId].boostAmount;
            logContext.amountFromBonus = transferResults[boostId].amountFromBonus;
        }

        return {
            boostId,
            accountIds: Object.keys(thisBoostAccountMap),
            newStatus: highestStatus,
            stillActive: !(isChangeRedemption && appliesToAll),
            logType: 'STATUS_CHANGE',
            logContext
        };
    });
};

const checkAndMarkSaveForPool = async (boostsForStatusChange, event) => {
    const boostsWithPooledReward = boostsForStatusChange.filter((boost) => boost.rewardParameters && boost.rewardParameters.rewardType === 'POOLED');
    const { transactionTags } = event.eventContext;

    if (boostsWithPooledReward.length > 0 && Array.isArray(transactionTags)) {
        const boostIds = boostsWithPooledReward.map((boost) => boost.boostId);
        const boostTag = transactionTags.find((tag) => tag.startsWith('BOOST'));
        logger('Checking boost tag: ', boostTag, ' against IDs : ', boostIds, ' from transaction tags: ', transactionTags);
        const taggedId = boostTag ? boostTag.split('::')[1] : null;
        if (taggedId && boostIds.includes(taggedId)) {
            const poolLog = { boostId: taggedId, accountId: event.accountId, logType: 'BOOST_POOL_CONTRIBUTION', logContext: event };
            const resultOfLogInsertion = await persistence.insertBoostAccountLogs([poolLog]);
            logger('Result of log insertion: ', resultOfLogInsertion);    
        }
    }
};

const publishWithdrawalLog = async (boost, newStatus, accountMap) => {
    const eventType = `WITHDRAWAL_BOOST_${newStatus}`;
    const userIds = Object.values(accountMap).map(({ userId }) => userId);
    const logContext = util.constructBoostContext(boost);
    logger('Publishing ', eventType, ' for: ', userIds);
    await publisher.publishMultiUserEvent(userIds, eventType, { context: logContext });
};

const fetchHistoryFromLogs = async (startTime, eventsOfInterest, thisEvent) => {
    const { eventType, userId, timeInMillis: timestamp } = thisEvent;
    const historyPayload = { userId, eventTypes: eventsOfInterest, startDate: startTime.valueOf(), excludeContext: true };
    logger('Fetching history with payload: ', historyPayload);

    const historyResult = await lambda.invoke(util.lambdaParameters(historyPayload, 'userHistory', true)).promise();
    const resultPayload = JSON.parse(historyResult.Payload);
    logger('Obtained from history: ', resultPayload);

    const loggedEvents = resultPayload[userId].userEvents;
    // note : multiple queues working at once, so possible that this is running before user log has logged the event and made it available
    // hence, we check for it and if it is not present, we insert it; condition tester will do obvious sort
    if (!loggedEvents.some((event) => event.eventType === eventType && event.timestamp === timestamp)) {
        loggedEvents.push({ eventType, userId, timestamp });
    }

    logger('After check, returning: ', JSON.stringify(loggedEvents));
    return loggedEvents;
};

const boostHasSecondEventMatching = (boost, eventType) => {
    const flattenedConditions = Object.values(boost.statusConditions).reduce((allList, thisList) => [...allList, ...thisList], []);
    const secondEventsInSequenceConditions = flattenedConditions.filter(util.conditionIsTimeBased).
        map(util.extractSequenceAndIntervalFromCondition).map(({ secondEvent }) => secondEvent);
    logger('Second events: ', secondEventsInSequenceConditions, ' and this event type: ', eventType);
    return secondEventsInSequenceConditions.some((secondEventType) => secondEventType === eventType);
};

// these are heavy calls so we only do them when the present event appears in second place in sequence, and then we 
// retrieve only those events that are relevant
const obtainEventHistoryForBoosts = async (boosts, event) => {
    const relevantBoosts = boosts.filter((boost) => boostHasSecondEventMatching(boost, event.eventType));
    logger('These boosts have second-slot events matching current: ', JSON.stringify(relevantBoosts, null, 2));
    if (relevantBoosts.length === 0) {
        return [];
    }

    // for those that do, we need all events, including the first ones, because condition tester needs the timestamps
    const allSequenceEvents = relevantBoosts.map(util.extractEventsInSequenceConditions).
        reduce((allList, thisList) => [...allList, ...thisList], []);
    // note : keep an eye out for extreme corner case where we still have more than one boosts here and sequences might overlap
    const earliestBoost = relevantBoosts.sort((boostA, boostB) => boostA.boostStartTime.valueOf() - boostB.boostStartTime.valueOf()); // earliest first
    
    return fetchHistoryFromLogs(earliestBoost[0].boostStartTime, allSequenceEvents, event);
};

const processEventForExistingBoosts = async (event) => {
    const offeredOrPendingBoosts = await persistence.findBoost(extractFindBoostKey(event));
    logger('Processing event for existing boosts, current pending or offered: ', JSON.stringify(offeredOrPendingBoosts, null, 2));

    if (!offeredOrPendingBoosts || offeredOrPendingBoosts.length === 0) {
        logger('Well, nothing found, so just return');
        return { statusCode: statusCodes('Ok'), body: JSON.stringify({ boostsTriggered: 0 })};
    }

    const boostsWithIntervalOrSequenceConditions = offeredOrPendingBoosts.filter((boost) => util.hasTimeBasedConditions(boost));
    logger('How many boosts have time based conditions: ', boostsWithIntervalOrSequenceConditions.length);
    if (boostsWithIntervalOrSequenceConditions.length > 0) {
        logger('Enriching event with user history, if applicable');
        const eventHistory = await obtainEventHistoryForBoosts(boostsWithIntervalOrSequenceConditions, event);
        event.eventContext = event.eventContext ? { ...event.eventContext, eventHistory } : { eventHistory };
    }

    // for each offered or pending boost, we check if the event triggers a status change, and hence compose an object
    // whose keys are the boost IDs and whose values are the lists of statuses whose conditions have been met
    const boostStatusChangeDict = { };
    offeredOrPendingBoosts.forEach((boost) => {
        boostStatusChangeDict[boost.boostId] = conditionTester.extractStatusChangesMet(event, boost);
    });
    logger('Map of status changes triggered: ', boostStatusChangeDict);
    
    const boostsForStatusChange = offeredOrPendingBoosts.filter((boost) => boostStatusChangeDict[boost.boostId].length !== 0);
    // logger('These boosts were triggered: ', boostsForStatusChange);

    if (!boostsForStatusChange || boostsForStatusChange.length === 0) {
        logger('Boosts found, but none triggered to change, so exiting');
        return { boostsTriggered: 0 };
    }

    if (event.eventType === 'SAVING_PAYMENT_SUCCESSFUL') {
        await checkAndMarkSaveForPool(boostsForStatusChange, event);
    }

    logger('At least one boost was triggered. First step is to extract affected accounts, then tell the float to transfer from bonus pool');
    // note : this is in the form, top level keys: boostID, which gives a dict, whose own key is the account ID, and an object with userId and status
    const affectedAccountsDict = await extractPendingAccountsAndUserIds(event.accountId, boostsForStatusChange);
    logger('Retrieved affected accounts and user IDs, with status: ', JSON.stringify(affectedAccountsDict));

    // then we prepar to update the statuses of the boosts, and hook up appropriate logs
    const logContextBase = event.eventContext ? JSON.parse(JSON.stringify(event.eventContext)) : {}; // else we get weird mutability stuff, including in tests

    // first, do the float allocations. we do not parallel process this as if it goes wrong we should not proceed
    const boostsToRedeem = boostsForStatusChange.filter((boost) => boostStatusChangeDict[boost.boostId].indexOf('REDEEMED') >= 0);
    // then we also check for withdrawal boosts
    const boostsToRevoke = boostsForStatusChange.filter((boost) => boostStatusChangeDict[boost.boostId].indexOf('REVOKED') >= 0);

    let resultOfTransfers = {};
    if (boostsToRedeem.length > 0 || boostsToRevoke.length > 0) {
        const redemptionCall = { redemptionBoosts: boostsToRedeem, revocationBoosts: boostsToRevoke, affectedAccountsDict: affectedAccountsDict, event };

        if (boostsToRedeem.some((boost) => boost.rewardParameters && boost.rewardParameters.rewardType === 'POOLED')) {
            logger('We have a pooled reward, go fetch details');
            redemptionCall.pooledContributionMap = await fetchAccountIdsForPooledRewards(boostsToRedeem);
        }

        logger('REDEMPTION CALL: ', redemptionCall);
        resultOfTransfers = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
        logContextBase.transferResults = resultOfTransfers;
    }

    // a little ugly with the repeat if statements, but we want to make sure if the redemption call fails, the user is not updated to redeemed spuriously 
    const updateInstructions = generateUpdateInstructions(boostsForStatusChange, boostStatusChangeDict, affectedAccountsDict, logContextBase);
    logger('Sending these update instructions to persistence: ', updateInstructions);

    const resultOfUpdates = await persistence.updateBoostAccountStatus(updateInstructions);
    logger('Result of update operation: ', resultOfUpdates);

    // and finally, we do some updates in two special cases: (i) there were any redemptions, (ii) the boosts are withdrawal-related offers
    if (resultOfTransfers && Object.keys(resultOfTransfers).length > 0) {
        // could do this inside boost redemption handler, but then have to give it persistence connection, and not worth solving that now
        const boostsToUpdateRedemption = [...util.extractBoostIds(boostsToRedeem), ...util.extractBoostIds(boostsToRevoke)];
        persistence.updateBoostAmountRedeemed(boostsToUpdateRedemption);        
    }

    const withdrawalRelatedBoosts = boostsForStatusChange.filter((boost) => boost.flags && boost.flags.includes('WITHDRAWAL_RELATED'));
    if (withdrawalRelatedBoosts.length > 0) {
        await Promise.all(withdrawalRelatedBoosts.map((boost) => publishWithdrawalLog(boost, boostStatusChangeDict[boost.boostId][0], affectedAccountsDict[boost.boostId])));
    }

    return {
        result: 'SUCCESS',
        resultOfTransfers,
        resultOfUpdates
    };
};

// /////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// SECTION FOR EXPIRING BOOSTS ///////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////

const checkIfAccountWinsTournament = (accountId, redemptionConditions, boostLogs) => {
    const eventContext = { accountScoreList: boostLogs };
    // logger('Created event context: ', eventContext);
    const event = { eventType: 'BOOST_EXPIRED', accountId, eventContext };
    // logger('Checking for tournament win, sending in event: ', event);
    return conditionTester.testConditionsForStatus(event, redemptionConditions);
};

const sortAndRankBestScores = (boostGameLogs, accountIds) => {
    // first, create a map that has the unique highest score
    const highScoreMap = new Map();
    
    // no comparison is even possible if scores are of different types, so this can be set from first log
    const { logContext: firstLogContext } = boostGameLogs[0];
    const scoreType = typeof firstLogContext.numberTaps === 'number' ? 'NUMBER' : 'PERCENT';
    
    boostGameLogs.forEach((log) => {
        const { accountId, logContext } = log;
        const accountScore = logContext.numberTaps || logContext.percentDestroyed;
        
        if (!highScoreMap.has(accountId) || highScoreMap.get(accountId) < accountScore) {
            highScoreMap.set(accountId, accountScore);
        }
    });

    logger('High score map: ', highScoreMap);

    const sortedEntries = [...highScoreMap.values()].sort((score1, score2) => score2 - score1);
    logger('Entry scores, sorted: ', sortedEntries);

    const getAccountIdRanking = (accountId) => {
        const accountScore = highScoreMap.get(accountId);
        const gameAccountResult = { 
            accountScore,
            scoreType,
            ranking: sortedEntries.indexOf(highScoreMap.get(accountId)) + 1,
            topScore: sortedEntries[0]
        };

        // this next bit for backward compatibility (for on app itself), remove in a couple app versions
        if (scoreType === 'NUMBER') {
            gameAccountResult.numberTaps = accountScore; // leaving in temporarily for legacy
        } else {
            gameAccountResult.percentDestroyed = accountScore;
        }

        return gameAccountResult;
    };

    return accountIds.reduce((obj, accountId) => ({ ...obj, [accountId]: getAccountIdRanking(accountId) }), {});
};

const generateRedemptionAccountMap = async (boostId, winningAccounts) => {
    const findAccountParams = { boostIds: [boostId], accountIds: winningAccounts, status: util.ACTIVE_BOOST_STATUS };
    logger('Generating redemption account map, submitting account parameters: ', findAccountParams);

    const accountInfo = await persistence.findAccountsForBoost(findAccountParams);

    return { [boostId]: accountInfo[0].accountUserMap };
};

const expireAccountsForBoost = async (boostId, specifiedAccountIds) => {
    const accountIds = specifiedAccountIds || null; // null makes it all of them
    const accountsToExpire = await persistence.findAccountsForBoost({ boostIds: [boostId], status: util.ACTIVE_BOOST_STATUS, accountIds });
    const accountMap = accountsToExpire[0].accountUserMap;
    
    const updateInstruction = { boostId, newStatus: 'EXPIRED', accountIds: Object.keys(accountMap), logType: 'STATUS_CHANGE' };
    const resultOfExpiration = await persistence.updateBoostAccountStatus([updateInstruction]);
    logger('Result of expiring boosts: ', resultOfExpiration);

    const userIds = [...new Set(Object.values(accountMap).map((entry) => entry.userId))];
    publisher.publishMultiUserEvent(userIds, 'BOOST_EXPIRED', { context: { boostId }});
};

const handleTournamentWinners = async (boost, winningAccounts) => {
    const { boostId } = boost;

    const redemptionAccountDict = await generateRedemptionAccountMap(boostId, winningAccounts);
    logger('Redemption account dict: ', redemptionAccountDict);

    const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId };
    const redemptionCall = { 
        affectedAccountsDict: redemptionAccountDict, 
        event: redemptionEvent 
    };

    if (boost.rewardParameters && boost.rewardParameters.rewardType === 'POOLED') {
        const pooledContributionMap = await fetchAccountIdsForPooledRewards([boost]);
        // todo this is going to cause trouble with random rewards but minus 20 on time and just too much to do now, so fix when 
        // we actually start using random rewards (easy fix is pass this amount to boost redemption handler)
        const { boostAmount: revisedBoostAmount } = boostRedemptionHandler.calculateBoostAmount(boost, pooledContributionMap);
        logger('Updating boost amount to: ', revisedBoostAmount);
        
        boost.boostAmount = revisedBoostAmount; // so subsequent in-memory calls are correct
        await persistence.updateBoostAmount(boost.boostId, revisedBoostAmount);

        redemptionCall.pooledContributionMap = pooledContributionMap;
    }

    redemptionCall.redemptionBoosts = [boost]; // so it has the right amount in it for things like events etc
        
    const resultOfRedemptions = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
    logger('Result of redemptions for winners: ', resultOfRedemptions);

    const redemptionUpdate = { boostId, accountIds: winningAccounts, logType: 'STATUS_CHANGE', newStatus: 'REDEEMED' };
    const resultOfRedeemUpdate = await persistence.updateBoostAccountStatus([redemptionUpdate]);
    logger('And result of redemption account update: ', resultOfRedeemUpdate);

    const winningUserIds = Object.values(redemptionAccountDict[boostId]).map((entry) => entry.userId);
    await publisher.publishMultiUserEvent(winningUserIds, 'BOOST_TOURNAMENT_WON', { context: { boostId }});
};

const handleExpiredBoost = async (boostId) => {
    const [boost, boostGameLogs] = await Promise.all([persistence.fetchBoost(boostId), persistence.findLogsForBoost(boostId, GAME_RESPONSE)]);
    logger('Processing boost for expiry: ', boost);

    if (boost.boostType !== 'GAME' || !boostGameLogs || boostGameLogs.length === 0) {
        // just expire the boosts and be done
        logger('No game logs found, expiring all');
        await expireAccountsForBoost(boostId);
        return { resultCode: 200, body: 'Not a game, or no responses' };
    }

    const { statusConditions } = boost;
    if (!statusConditions || !statusConditions.REDEEMED) {
        logger('No redemption conditions, exiting');
        await expireAccountsForBoost(boostId);
        return { resultCode: 200, body: 'No redemption condition' };
    }
    
    const accountIdsThatResponded = [...new Set(boostGameLogs.map((log) => log.accountId))];
    
    logger('Account IDs with responses: ', accountIdsThatResponded);

    // not the most efficient thing in the world, but it will not happen often, and we can optimize later
    const winningAccounts = accountIdsThatResponded.filter((accountId) => checkIfAccountWinsTournament(accountId, statusConditions.REDEEMED, boostGameLogs));
    
    if (winningAccounts.length > 0) {
        logger('Handling tournament result, awarding to winners: ', winningAccounts);
        await handleTournamentWinners(boost, winningAccounts);
    }

    const allAccountMap = await persistence.findAccountsForBoost({ boostIds: [boostId], status: util.ACTIVE_BOOST_STATUS });
    const allAccountIds = Object.keys(allAccountMap[0].accountUserMap);
    
    const remainingAccounts = allAccountIds.filter((accountId) => !winningAccounts.includes(accountId));
    logger('Will expire these remaining accounts: ', remainingAccounts);
    const resultOfUpdate = await expireAccountsForBoost(boostId, remainingAccounts);
    logger('Result of expiry update: ', resultOfUpdate);

    // as above, inefficient, but to neaten up later
    const sortedAndRankedAccounts = sortAndRankBestScores(boostGameLogs, accountIdsThatResponded);
    logger('Sorted and ranked accounts: ', sortedAndRankedAccounts); 
    const resultLogs = accountIdsThatResponded.map((accountId) => ({
        boostId,
        accountId,
        logType: 'GAME_OUTCOME',
        logContext: sortedAndRankedAccounts[accountId]
    }));

    const resultOfLogInsertion = await persistence.insertBoostAccountLogs(resultLogs);
    logger('Finally, result of log insertion: ', resultOfLogInsertion);

    return { statusCode: 200, boostsRedeemed: winningAccounts.length };
};

const handleIndividualEvent = async (event) => {
    logger('Handling individual event received: ', event);
    if (event.eventType === 'BOOST_EXPIRED' && event.boostId) {
        return handleExpiredBoost(event.boostId);        
    }

    // second, we check if there is a pending boost for this account, or user, if we only have that
    if (!event.accountId && !event.userId) {
        return { statusCode: statusCodes('Bad request'), body: 'Function requires at least a user ID or accountID' };
    }

    if (!event.accountId) {
        // eslint-disable-next-line require-atomic-updates
        event.accountId = await persistence.getAccountIdForUser(event.userId);
        logger('Event account ID: ', event.accountId);
    }

    // third, find boosts that do not already have an entry for this user, and are created by this event
    const creationResult = await createBoostsTriggeredByEvent(event);
    logger('Result of boost-account creation creation:', creationResult);

    return processEventForExistingBoosts(event);
};

/**
 * Generic handler for any boost relevant response (add cash, solve game, etc)
 * Note: at present, since we handle a relatively limited range of events, this gets directly invoked,
 * though in future we may put it onto the same SNS topic as message process and event handler
 * @param {object} sqsBatch A batch of event objects containing the request context and request body. NOTE: this comes in via SQS.
 * @property {string} userId The users id.
 * @property {string} accountId The account id. Either the user id or the account id must be provided.
 */
module.exports.handleBatchOfQueuedEvents = async (sqsBatch) => {
    try {
        logger('Processing queue batch, exact format: ', JSON.stringify(sqsBatch, null, 2));
        
        const extractedEvents = opsUtil.extractSQSEvents(sqsBatch);

        // note : these do not come from SNS originally, hence pass directly
        const resultOfProcessing = await Promise.all((extractedEvents.map((event) => handleIndividualEvent(event))));
        logger('Result of processing: ', resultOfProcessing);

        return resultOfProcessing;
    } catch (error) {
        logger('FATAL_ERROR: ', error);
        return { statusCode: 500 };
    }
};
