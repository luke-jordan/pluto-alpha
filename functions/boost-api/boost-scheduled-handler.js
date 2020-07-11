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

const lambdaParameters = (payload, nameKey, sync) => ({
    FunctionName: config.get(`lambdas.${nameKey}`),
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

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
    const lambdaInvocation = lambdaParameters(payload, 'audienceHandle', true);
    const resultOfRefresh = await lambda.invoke(lambdaInvocation).promise();
    if (resultOfRefresh['StatusCode'] !== 200) {
        throw new Error('Error refreshing audience');
    }

    const newAccounts = await persistence.fetchNewAudienceMembers(boostId, audienceId);
    logger('Obtained new accounts for this boost: ', newAccounts);
    if (newAccounts.length === 0) {
        return { newOffers: 0 }
    }

    const { boostType, defaultStatus } = boost;
    const insertJoinResult = await persistence.insertBoostAccountJoins([boostId], newAccounts, defaultStatus);
    logger('Audience refresh, result of join insertion: ', insertJoinResult);

    const { messageInstructionIds } = boost;
    const newAccountUserIds = await persistence.findUserIdsForAccounts(newAccounts); 
    
    // todo : make sure not double triggering with message push/refresh
    if (messageInstructionIds && Object.keys(messageInstructionIds).includes(defaultStatus)) {
        const instructionsToTrigger = messageInstructionIds[defaultStatus];
        const msgParameters = extractBoostMsgParameters(boost);
        
        const instructions = assembleListOfMsgInstructions(newAccountUserIds, instructionsToTrigger, msgParameters);
        logger('Sending instruction-user pairs to msging : ', instructions);
        const msgInvocation = lambdaParameters({ instructions }, 'messageSend', false);
        
        const resultOfMsgSend = await lambda.invoke(msgInvocation).promise();
        logger('Result of message dispatch: ', resultOfMsgSend);
    }

    const logOptions = {
        initiator: boost.creatingUserId,
        context: boostUtil.constructBoostContext(boost)
    };
    
    await publisher.publishMultiUserEvent(newAccountUserIds, `BOOST_CREATED_${boostType}`, logOptions);

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

// these are time-based in the sense that they are triggered or not based on a sequence of events within a given time
const timeBasedConditions = ['event_does_follow', 'event_does_not_follow'];
    
// two helper filters to try make this easier to maintain/follow
const conditionIsTimeBased = (condition) => timeBasedConditions.some((timeBasedCondition) => condition.startsWith(timeBasedCondition));
const oneConditionTimeBased = (conditions) => conditions.some((condition) => conditionIsTimeBased(condition))

const hasTimeBasedConditions = (boost) => {
    const { statusConditions } = boost;
    return Object.values(statusConditions).some((conditions) => oneConditionTimeBased(conditions));
};

const extractSequenceAndIntervalFromCondition = (condition) => {
    const parameterMatch = condition.match(/#{(.*)}/);
    const [firstEvent, secondEvent, timeAmount, timeUnit] = parameterMatch[1].split('::');
    const parameters = { firstEvent, secondEvent, timeAmount, timeUnit };
    // logger('From parameter string: ', parameterMatch[1], ' extracted: ', parameters);
    return parameters;
}

// no point checking anything if no condition has possibly been met, so we find the date on which the first event
// would have had to happen for any of the conditions to be met
const extractFirstEventLatestTime = (statusConditions) => {
    const timeConditions = Object.values(statusConditions).reduce(flattenList, []).filter(conditionIsTimeBased);
    const currentMoment = moment();
    const conditionMoments = timeConditions.map(extractSequenceAndIntervalFromCondition)
        .map(({ timeAmount, timeUnit }) => currentMoment.clone().subtract(parseInt(timeAmount, 10), timeUnit));
    logger('Condition moments: ', conditionMoments);
    return moment.max(conditionMoments);
}

const extractEvents = (condition) => {
    const parameterMatch = condition.match(/#{(.*)}/);
    if (!parameterMatch) {
        return [];
    }
    // logger('Have values for parameter: ', parameterMatch);
    const [firstEvent, secondEvent] = parameterMatch[1].split('::');
    return [firstEvent, secondEvent];
};

const extractEventsFromConditions = (conditions) => conditions.filter(conditionIsTimeBased).map(extractEvents)
    .reduce((allList, thisList) => [...allList, ...thisList], []);

// the job of this method is to go fetch the relevant events for the users that it might be relevant for
const obtainUserEventHistory = async (userIds, eventTypes, startTime) => {
    // we exclude context because it is not necessary, and with it we might hit lambda payload size limits too quickly
    const lambdaParams = lambdaParameters({ userIds, eventTypes, startDate: startTime.valueOf(), excludeContext: true }, 'userHistory', true);
    const lambdaResults = await lambda.invoke(lambdaParams).promise();
    const resultPayload = JSON.parse(lambdaResults[index].Payload);
    logger('Event history lambda result: ', resultPayload);
    return resultPayload.eventHistoryMap; // returns in format { [userId]: [listOfEvents] }
};

const determineUsersMeetingConditions = async (boost, accountUserMap) => {
    const { statusConditions } = boost;

    const sequenceDependentStatusses = Object.keys(statusConditions).filter((status) => oneConditionTimeBased(statusConditions[status]));
    logger('Processing boost, sequence dependent statusses; ', sequenceDependentStatusses);

    // as in general, three levels of lists to untangle here: statusses, then conditions, then events within condition
    const eventsToObtainRaw = sequenceDependentStatusses.map((status) => extractEventsFromConditions(statusConditions[status]));
    logger('Raw events to obtain: ', eventsToObtainRaw);
    const eventsToObtain = [...new Set(eventsToObtainRaw.reduce((allList, thisList) => [...allList, ...thisList]))];
    logger('Deduped: ', eventsToObtain);

    const userIds = Object.values(accountUserMap).map(({ userId }) => userId);
    logger('Fetching for user IDs: ', userIds);

    const eventHistoryMap = await obtainUserEventHistory(userIds, eventsToObtain, boost.boostStartTime);

    const syntheticEventForUser = (accountId) => ({
        eventType: 'SEQUENCE_CHECK',
        eventContext: { 
            userId: accountUserMap[accountId].userId, 
            eventHistory: eventHistoryMap[accountUserMap[accountId].userId] 
        }
    });

    const statusMetForUser = (accountId) => conditionTester.extractStatusChangesMet(syntheticEventForUser(accountId), boost);
    const accountsMeetingConditions = Object.keys(accountUserMap).map((accountId) => ({ accountId, statusMet: statusMetForUser(accountId) }));
    logger('Extracted these users meeting status conditions now: ', accountsMeetingConditions);

    return { accountsMeetingConditions, eventHistoryByAccount };
};

const extractHighestStatus = (statusMet) => statusMet.sort(boostUtil.statusSorter)[0];

const assembleUpdateInstruction = (accountStatusPair, eventHistoryByAccount, boost) => ({
    boostId: boost.boostId,
    accountIds: [accountStatusPair.accountId],
    logType: 'STATUS_CHANGE',
    newStatus: accountStatusPair.highestStatus,
    logContext: { eventHistory: eventHistoryByAccount[accountStatusPair.accountId] }
});

// see above on over-doing, or not, parallel processing
const processBoostWithTimeSequenceCondition = async (boost, userAccountMap) => {
    const { statusConditions, boostStartTime } = boost;

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
    if (accountsChangingStatus.length === 0) {
        return { accountsUpdated: 0 };
    }

    // then we extract the "highest", i.e., latest of those
    const accountsWithHighestStatus = accountsChangingStatus.
        map(({ accountId, statusMet }) => ({ accountId, highestStatus: extractHighestStatus(statusMet) }));

    // check if any of them require a redemption
    const accountsWithRedemptions = accountsWithHighestStatus.filter(({ highestStatus }) => highestStatus === 'REDEEMED');

    if (accountsWithRedemptions.length > 0) {
        const eventContext = { eventHistory: eventHistoryByAccount};
        const syntheticEvent = { eventType: 'SEQUENCE_CHECK', eventContext };
        // redemption handler assumes everyone passed to it should be redeemed
        const affectedAccountsDict = accountsWithRedemptions.reduce((obj, { accountId }) => ({ ...obj, [accountId]: userAccountMap[accountId] }), {});
        const redemptionCall = { redemptionBoosts: [boost], affectedAccountsDict, event: syntheticEvent };
        logger('Redeeming boosts with call: ', redemptionHandler);
        const redemptionResult = await redemptionHandler.redeemOrRevokeBoosts(redemptionCall);
        logger('Redemption result: ', redemptionResult);
    }

    const updateInstructions = accountsWithHighestStatus.map((accountStatusPair) => (
        assembleUpdateInstruction(accountStatusPair, eventHistoryByAccount, boost))
    );

    const resultOfUpdate = await persistence.updateBoostAccountStatus(updateInstructions);
    logger('Status update completed: ', resultOfUpdate);

    return { accountsUpdated: updateInstructions.length, redemptions: accountsWithRedemptions.length };
};

module.exports.processTimeBasedConditions = async () => {
    logger('Initiating processing of boosts with time-based conditions');
    const activeStandardBoosts = await persistence.fetchActiveStandardBoosts();
    logger('Time based condition processing, retrieved boosts: ', activeStandardBoosts);
    if (activeStandardBoosts.length === 0) {
        return { boostsProcessed: 0 }
    }

    const boostsWithSeqCondition = activeStandardBoosts.filter((boost) => hasTimeBasedConditions(boost));
    if (boostsWithSeqCondition.length === 0) {
        logger('No active standard boosts have time-based status triggers');
        return { boostsProcessed: 0 };
    }

    // heavy operations, so only get the users where this can be relevant
    const boostIds = boostsWithSeqCondition.map((boost) => boost.boostId);
    const stillOpenAccounts = await persistence.findAccountsForBoost({ boostIds, status: boostUtil.ACTIVE_BOOST_STATUS });
    // normalize so can do quick lookups
    const userIdAccountMap = stillOpenAccounts.reduce((obj, { boostId, accountUserMap }) => ({ ...obj, [boostId]: accountUserMap }), {});

    const relevantBoosts = boostsWithSeqCondition.filter((boost) => Object.keys(userIdAccountMap[boost.boostId]).length > 0);

    const processPromises = relevantBoosts.map((boost) => processBoostWithTimeSequenceCondition(boost, userIdAccountMap[boost.boostId]));
    const resultOfProcess = await Promise.all(processPromises);
    
    const boostsTriggered = resultOfProcess.filter((result) => result.accountsUpdated > 0).length;

    return { boostsProcessed: boostsWithSeqCondition.length, boostsTriggered };
};

/**
 * Helper method that allows calling the others. Exporting the others for simpler testing and may at some point put on their own lambdas
 * @param {object} event Usual AWS event, disregarded as called on schedule (in future may use to pass processing restrictions) 
 */
module.exports.handleAllScheduledTasks = async (event) => {
    try {
        logger('Initiating scheduled time-based boost jobs');
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