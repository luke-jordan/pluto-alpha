'use strict';

const logger = require('debug')('jupiter:boosts:scheduled');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds.boost');
const publisher = require('publish-common');

const opsUtil = require('ops-util-common');
const boostUtil = require('./boost.util');

const conditionTester = require('./condition-tester');
const redemptionHandler = require('./boost-redemption-handler');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const extractExpiryTime = (boost) => {
    const { boostEndTime, expiryParameters} = boost;
    if (!expiryParameters || !expiryParameters.individualizedExpiry) {
        return boostEndTime;
    }

    const timeUntilExpiry = expiryParameters.timeUntilExpiry || config.get('time.offerToExpiryDefault');
    return moment().add(timeUntilExpiry.value, timeUntilExpiry.unit);
};

// may need to add more in future but for now should be enough
const extractBoostMsgParameters = (boost) => ({
    boostAmount: opsUtil.formatAmountCurrency({ amount: boost.boostAmount, unit: boost.boostUnit, currency: boost.boostCurrency })
});

const assembleListOfMsgInstructions = (userIds, instructionIds, parameters) => userIds.
    map((destinationUserId) => instructionIds.
    map((instructionId) => ({ instructionId, destinationUserId, parameters }))).
    reduce((fullList, thisList) => [...fullList, ...thisList]);

// note : there are obviously ways to do several of these operations once-per-multiple-boosts
// _but_ learning lesson from boost-event-handler, that would increase maintenance costs significantly
// and there are very low odds of this being called with more than 2-3 boosts at a time until team is much larger
// and can come back and make efficient, so for now we are consciously doing it this way
const handleBoostWithDynamicAudience = async (boost) => {
    const { boostId, audienceId } = boost;

    const payload = { operation: 'refresh', params: { audienceId } };
    const lambdaInvocation = boostUtil.lambdaParameters(payload, 'audienceHandle', true);
    const resultOfRefresh = await lambda.invoke(lambdaInvocation).promise();
    if (resultOfRefresh['StatusCode'] !== 200) {
        throw new Error('Error refreshing audience');
    }

    const newAccounts = await persistence.fetchNewAudienceMembers(boostId, audienceId);
    logger('Obtained new accounts for this boost: ', newAccounts);
    if (newAccounts.length === 0) {
        return { newOffers: 0 };
    }

    const { boostType, defaultStatus } = boost;
    const expiryTime = extractExpiryTime(boost);
    const insertJoinResult = await persistence.insertBoostAccountJoins([boostId], newAccounts, defaultStatus, expiryTime);
    logger('Audience refresh, result of join insertion: ', insertJoinResult);

    const { messageInstructions } = boost;
    const newAccountUserIds = await persistence.findUserIdsForAccounts(newAccounts);
    logger('Extracted user Ids for new accounts: ', newAccountUserIds);
    
    // todo : make sure not double triggering with message push/refresh
    if (Array.isArray(messageInstructions) && messageInstructions.filter(({ status }) => status === defaultStatus).length > 0) {

        const instructionsToTrigger = messageInstructions.
            filter(({ status }) => status === defaultStatus).
            map(({ msgInstructionId }) => msgInstructionId);
        const msgParameters = extractBoostMsgParameters(boost);
        
        const instructions = assembleListOfMsgInstructions(newAccountUserIds, instructionsToTrigger, msgParameters);
        logger('Sending instruction-user pairs to msging : ', instructions);
        const msgInvocation = boostUtil.lambdaParameters({ instructions }, 'messageSend', false);
        
        const resultOfMsgSend = await lambda.invoke(msgInvocation).promise();
        logger('Result of message dispatch: ', resultOfMsgSend);
    }

    logger('Triggering user logs for boost ... : user Ids: ', JSON.stringify(newAccountUserIds));

    const statusToLog = boostUtil.getStatusPrior(defaultStatus);
    const logOptions = { initiator: boost.creatingUserId, context: boostUtil.constructBoostContext(boost) };    

    const promisePublicationMap = statusToLog.map((status) => `BOOST_${status}_${boostType}`).
        map((eventType) => publisher.publishMultiUserEvent(newAccountUserIds, eventType, logOptions));

    await Promise.all(promisePublicationMap);
    
    return { newOffers: newAccounts.length };
};

module.exports.refreshDynamicAudienceBoosts = async () => {
    logger('Initiating dynamic audience refresh');
    const activeBoostsWithDynamicAudiences = await persistence.fetchBoostsWithDynamicAudiences();
    logger('Dynamic audience processing, retrieved boosts: ', activeBoostsWithDynamicAudiences);

    if (activeBoostsWithDynamicAudiences.length === 0) {
        return { result: 'NO_BOOSTS' };
    }

    const resultOfRefresh = await Promise.all(activeBoostsWithDynamicAudiences.map((boost) => handleBoostWithDynamicAudience(boost)));
    logger('Collected results of refresh: ', resultOfRefresh);

    const newOffers = resultOfRefresh.reduce((sum, result) => sum + result.newOffers, 0);

    return { result: 'BOOSTS_REFRESHED', boostsRefreshed: activeBoostsWithDynamicAudiences.length, newOffers };
};

// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////////////// EVENT SEQUENCE CONDITIONS /////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// several layers of nested lists in here, so this is going to be handy
const flattenList = (allList, thisList) => [...allList, ...thisList];

// no point checking anything if no condition has possibly been met, so we find the date on which the first event
// would have had to happen for any of the conditions to be met
const extractFirstEventLatestTime = (statusConditions) => {
    const timeConditions = Object.values(statusConditions).reduce(flattenList, []).filter(boostUtil.conditionIsTimeBased);
    const currentMoment = moment();
    const conditionMoments = timeConditions.map(boostUtil.extractSequenceAndIntervalFromCondition).
        map(({ timeAmount, timeUnit }) => currentMoment.clone().subtract(parseInt(timeAmount, 10), timeUnit));
    logger('Condition moments: ', conditionMoments);
    return moment.max(conditionMoments);
};

// the job of this method is to go fetch the relevant events for the users that it might be relevant for
const obtainUserEventHistory = async (userIds, eventTypes, startTime) => {
    // we exclude context because it is not necessary, and with it we might hit lambda payload size limits too quickly
    const historyPayload = { userIds, eventTypes, startDate: startTime.valueOf(), excludeContext: true };
    const lambdaParams = boostUtil.lambdaParameters(historyPayload, 'userHistory', true);
    const lambdaResults = await lambda.invoke(lambdaParams).promise();
    const resultPayload = JSON.parse(lambdaResults.Payload);
    logger('Event history lambda result: ', resultPayload);
    if (resultPayload.result !== 'SUCCESS') {
        throw new Error('Error obtaining user history, result payload: ', resultPayload);
    }
    Reflect.deleteProperty(resultPayload, 'result'); // not needed anymore
    return resultPayload; // returns in format { [userId]: [listOfEvents] }
};

const determineUsersMeetingConditions = async (boost, accountUserMap) => {
    const accountIds = Object.keys(accountUserMap);

    const eventsToObtain = boostUtil.extractEventsInSequenceConditions(boost);
    
    const userIds = Object.values(accountUserMap).map(({ userId }) => userId);
    logger('Fetching for user IDs: ', userIds);

    const eventHistoryMap = await obtainUserEventHistory(userIds, eventsToObtain, boost.boostStartTime);

    // condition tester wants an 'event', so we package up the history into one, then construct a handy map of such events, using some helpers along the way
    const syntheticEventForUser = (userId) => ({
        eventType: 'SEQUENCE_CHECK',
        eventContext: { 
            userId, eventHistory: eventHistoryMap[userId].userEvents 
        }
    });
    const syntheticEvents = accountIds.reduce((obj, accountId) => ({ ...obj, [accountId]: syntheticEventForUser(accountUserMap[accountId].userId) }), {});
    logger('Generated synthetic events, for boost: ', boost.boostId, ', as: ', JSON.stringify(syntheticEvents, null, 2));

    // and finally we are in a position to check the statusses
    const statusMetForUser = (accountId) => conditionTester.extractStatusChangesMet(syntheticEvents[accountId], boost);
    const accountsMeetingConditions = accountIds.map((accountId) => ({ accountId, statusMet: statusMetForUser(accountId) }));
    logger('Extracted these users meeting status conditions now: ', accountsMeetingConditions);

    // then we return the accounts that met a status condition, along with a normalized map of event history for logging, and return them
    const eventHistoryByAccount = accountIds.
        reduce((obj, accountId) => ({ ...obj, [accountId]: eventHistoryMap[accountUserMap[accountId].userId].userEvents }), {});

    return { accountsMeetingConditions, eventHistoryByAccount };
};

const extractHighestStatus = (statusMet) => statusMet.sort(boostUtil.statusSorter)[0];

const assembleLogContext = (accountWithStatus, eventHistoryByAccount) => ({
    newStatus: accountWithStatus.newStatus,
    oldStatus: accountWithStatus.oldStatus, 
    eventHistory: eventHistoryByAccount[accountWithStatus.accountId]
});

const assembleUpdateInstruction = (accountWithStatus, eventHistoryByAccount, boostId, redemptionResult) => {
    const logContext = assembleLogContext(accountWithStatus, eventHistoryByAccount);
    if (redemptionResult && redemptionResult[boostId]) {
        logContext.accountTxIds = redemptionResult[boostId].accountTxIds;
        logContext.floatTxIds = redemptionResult[boostId].floatTxIds;
        logContext.boostAmount = redemptionResult[boostId].boostAmount;
        logContext.amountFromBonus = redemptionResult[boostId].amountFromBonus;
    }

    return {
        boostId: boostId,
        accountIds: [accountWithStatus.accountId],
        logType: 'STATUS_CHANGE',
        newStatus: accountWithStatus.newStatus,
        logContext 
    };
};

// see above on over-doing, or not, parallel processing
const processBoostWithTimeSequenceCondition = async (boost, userAccountMap) => {
    const { boostId, statusConditions, boostStartTime } = boost;

    // if all conditions require 30 days between two events, and boost is 15 days old, nothing could be triggered, so exit
    const enoughTimeElapsedCheckMoment = extractFirstEventLatestTime(statusConditions);
    logger('Boost would have had to start before: ', enoughTimeElapsedCheckMoment, ' and it did start on: ', boost.boostStartTime);
    if (enoughTimeElapsedCheckMoment.isBefore(boostStartTime)) {
        logger('Boost is too recent, exit');
        return { accountsUpdated: 0 };
    }

    // for the relevant users, fetch their history, and determine if any of them meet the conditions
    const { accountsMeetingConditions, eventHistoryByAccount } = await determineUsersMeetingConditions(boost, userAccountMap);

    // then we process the highest status of those, and generate an update transaction
    const accountsChangingStatus = accountsMeetingConditions.filter(({ statusMet }) => statusMet.length > 0);
    logger('These accounts will change status: ', accountsChangingStatus);
    if (accountsChangingStatus.length === 0) {
        logger('No accounts changed status, so exiting');
        return { accountsUpdated: 0 };
    }

    // then we extract the "highest", i.e., latest of those, as the new status, and retain the old for logging
    const accountsWithNewStatus = accountsChangingStatus.
        map(({ accountId, statusMet }) => ({ accountId, newStatus: extractHighestStatus(statusMet), oldStatus: userAccountMap[accountId].status }));

    // divide into those requiring a redemption and those without
    const accountsWithRedemptions = accountsWithNewStatus.filter(({ newStatus }) => newStatus === 'REDEEMED');
    const accountsWithoutRedemptions = accountsWithNewStatus.filter(({ newStatus }) => newStatus !== 'REDEEMED');

    if (accountsWithoutRedemptions.length > 0) {
        const nonRedeemedUpdates = accountsWithoutRedemptions.map((accountWithStatus) => 
            assembleUpdateInstruction(accountWithStatus, eventHistoryByAccount, boostId));
    
        const resultOfNonRedeemUpdate = await persistence.updateBoostAccountStatus(nonRedeemedUpdates);
        logger('Status update completed for non-redeemed but triggered: ', resultOfNonRedeemUpdate);    
    }

    if (accountsWithRedemptions.length > 0) {
        const eventContext = { eventHistory: eventHistoryByAccount};
        const syntheticEvent = { eventType: 'SEQUENCE_CHECK', eventContext };
        
        const accountMap = accountsWithRedemptions.
            reduce((obj, { accountId }) => ({ ...obj, [accountId]: { ...userAccountMap[accountId], newStatus: 'REDEEMED' } }), {});
        const affectedAccountsDict = { [boostId]: accountMap }; // see note above about excess complexity to allow too-early parallelism
        const redemptionCall = { redemptionBoosts: [boost], affectedAccountsDict, event: syntheticEvent };
        logger('Redeeming boosts with call: ', redemptionCall);
        const redemptionResult = await redemptionHandler.redeemOrRevokeBoosts(redemptionCall);
        logger('Redemption result: ', redemptionResult);
        const redeemUpdateInstructions = accountsWithRedemptions.map((accountWithStatus) => 
            assembleUpdateInstruction(accountWithStatus, eventHistoryByAccount, boostId, redemptionResult));
        await persistence.updateBoostAccountStatus(redeemUpdateInstructions); // leave in sequence, not parallel, with subsequent
        await persistence.updateBoostAmountRedeemed([boost.boostId]);
    }

    return { accountsUpdated: accountsWithNewStatus.length, redemptions: accountsWithRedemptions.length };
};

module.exports.processTimeBasedConditions = async () => {
    logger('Initiating processing of boosts with time-based conditions');
    const activeStandardBoosts = await persistence.fetchActiveStandardBoosts();
    logger('Time based condition processing, retrieved boosts: ', activeStandardBoosts);
    if (activeStandardBoosts.length === 0) {
        return { boostsProcessed: 0 };
    }

    const boostsWithSeqCondition = activeStandardBoosts.filter((boost) => boostUtil.hasTimeBasedConditions(boost));
    if (boostsWithSeqCondition.length === 0) {
        logger('No active standard boosts have time-based status triggers');
        return { boostsProcessed: 0 };
    }

    // heavy operations, so only get the users where this can be relevant
    const boostIds = boostsWithSeqCondition.map((boost) => boost.boostId);
    const stillOpenAccounts = await persistence.findAccountsForBoost({ boostIds, status: boostUtil.ACTIVE_BOOST_STATUS });
    // normalize so can do quick lookups
    const userIdAccountMap = stillOpenAccounts.reduce((obj, { boostId, accountUserMap }) => ({ ...obj, [boostId]: accountUserMap }), {});

    // retain only those boosts that have accounts in non-complete state 
    const relevantBoosts = boostsWithSeqCondition.filter((boost) => !opsUtil.isObjectEmpty(userIdAccountMap[boost.boostId]));
    logger('In processing time based conditions, after filtering, boosts left to process: ', relevantBoosts);

    const processPromises = relevantBoosts.map((boost) => processBoostWithTimeSequenceCondition(boost, userIdAccountMap[boost.boostId]));
    const resultOfProcess = await Promise.all(processPromises);
    
    const boostsTriggered = resultOfProcess.filter((result) => result.accountsUpdated > 0).length;
    const accountsUpdated = resultOfProcess.reduce((sum, result) => sum + result.accountsUpdated, 0);

    return { boostsProcessed: boostsWithSeqCondition.length, boostsTriggered, accountsUpdated };
};

/**
 * Helper method that allows calling the others. Exporting the others for simpler testing and may at some point put on their own lambdas
 * @param {object} event Usual AWS event, disregarded as called on schedule (in future may use to pass processing restrictions) 
 */
module.exports.handleAllScheduledTasks = async (event) => {
    try {
        logger('Initiating scheduled time-based boost jobs, event received: ', JSON.stringify(event));
        const [resultOfTimeProcessing, resultOfAudienceRefreshing] = await Promise.all([
            exports.processTimeBasedConditions(),
            exports.refreshDynamicAudienceBoosts()
        ]);

        const resultOfProcessing = { resultOfTimeProcessing, resultOfAudienceRefreshing };
        logger('Completed processing, exiting with result: ', resultOfProcessing);
        return { statusCode: 200, resultOfProcessing };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }

};
