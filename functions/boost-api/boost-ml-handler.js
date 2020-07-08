'use strict';

const logger = require('debug')('jupiter:boosts:ml');
const moment = require('moment');
const config = require('config');

const persistence = require('./persistence/rds.boost');
const tiny = require('tiny-json-http');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const triggerMsgInstructions = async (boost, accountIds) => {
    logger('Triggering message instruction for boost:', boost, 'And account ids:', accountIds);
    return boost;
};

const sendRequestToRefreshAudience = async (audienceId) => {
    logger('Refreshing audience:', audienceId);
    const audiencePayload = { operation: 'refresh', params: { audienceId } };

    const audienceInvocation = {
        FunctionName: config.get('lambdas.audienceHandle'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(audiencePayload)
    };

    const resultOfRefresh = await lambda.invoke(audienceInvocation).promise();
    logger('Raw result of audience refresh: ', resultOfRefresh);
    const resultPayload = JSON.parse(resultOfRefresh['Payload']);
    const resultBody = JSON.parse(resultPayload.body);
    logger('Result body for audience refresh: ', resultBody);
};

const obtainUsersForOffering = async (boost, userIds) => {
    const options = { url: config.get('dataPipeline.endpoint'), data: { boost, userIds } };
    const result = await tiny.get(options);
    logger('Result of ml boost user selection:', result);
    return result;
};

const hasValidMinInterval = (lastOfferedTime, minInterval) => {
    const currentInterval = moment().diff(moment(lastOfferedTime), minInterval.unit);
    logger(`Interval between last boost an now is: ${currentInterval} ${minInterval.unit}`);
    if (!lastOfferedTime || currentInterval >= minInterval.value) {
        return true;
    }

    return false;
};

const filterAccountIds = async (boost, accountIds) => {
    if (boost.mlParameters.onlyOfferOnce) {
        const boostAccountStatuses = await persistence.fetchBoostAccountStatuses(boost.boostId, accountIds);
        logger('Got boost account statuses:', boostAccountStatuses);
        const createdBoostStatuses = boostAccountStatuses.filter((accountStatus) => accountStatus.boostStatus === 'CREATED');
        return createdBoostStatuses.map((boostStatus) => boostStatus.accountId);
    }

    const { minIntervalBetweenRuns } = boost.mlParameters;

    const boostLogPromises = accountIds.map((accountId) => persistence.findLastLogForBoost(boost.boostId, accountId, 'ML_BOOST_OFFERED'));
    const boostLogs = await Promise.all(boostLogPromises);
    logger('Got boost logs:', boostLogs);
    const boostLogsWithValidIntervals = boostLogs.filter((boostLog) => hasValidMinInterval(boostLog.creationTime || null, minIntervalBetweenRuns));
    return boostLogsWithValidIntervals.map((boostLog) => boostLog.accountId);
};

const selectUsersForBoostOffering = async (boost) => {
    await sendRequestToRefreshAudience(boost.audienceId);

    const audienceAccountIds = await persistence.extractAccountIds(boost.audienceId);
    logger('Got audience account ids:', audienceAccountIds);
    const filteredAccountIds = await filterAccountIds(boost, audienceAccountIds);
    logger('Got filtered account ids:', filteredAccountIds);

    if (filteredAccountIds.length === 0) {
        return { message: 'No valid accounts found for ML boost' };
    }

    const accountUserIdMap = await persistence.findUserIdsForAccounts(filteredAccountIds, true);
    logger('Got user ids for accounts:', accountUserIdMap);
    const userIds = Object.keys(accountUserIdMap);
    const userIdsForOffering = await obtainUsersForOffering(boost, userIds);
    logger('Got user ids selected for boost offering:', userIdsForOffering);
    const accountIdsForOffering = userIdsForOffering.map((userId) => accountUserIdMap[userId]);

    return { boostId: boost.boostId, accountIds: accountIdsForOffering };
};

const createUpdateInstruction = (boostId, accountIds) => ({ boostId, accountIds, newStatus: 'OFFERED', logType: 'ML_BOOST_OFFERED' });

/**
 * A scheduled job that pulls and processes active ML boosts.
 * @param {object} event 
 */
module.exports.processMlBoosts = async (event) => {
    try {
        logger('ML boost process recieved event', event);

        // todo: event validation
        const mlBoosts = await persistence.fetchActiveMlBoosts();
        logger('Got machine-determined boosts:', mlBoosts);

        // todo: filter out results where no accounts survive the filter (once-off boosts where all accounts have already been offered)
        const boostsAndRecipients = await Promise.all(mlBoosts.map((boost) => selectUsersForBoostOffering(boost)));
        logger('Got boosts and recipients:', boostsAndRecipients);

        const statusUpdateInstructions = boostsAndRecipients.map((boost) => createUpdateInstruction(boost.boostId, boost.accountIds));
        logger('Created boost status update instructions:', statusUpdateInstructions);

        const resultOfUpdate = persistence.updateBoostAccountStatus(statusUpdateInstructions);
        logger('Result of boost account status update:', resultOfUpdate);

        const msgInstructionPromises = boostsAndRecipients.map((boost) => triggerMsgInstructions(boost.boostId, boost.accountIds));
        const resultOfMsgInstructions = await Promise.all(msgInstructionPromises);
        logger('triggering message instructions resulted in:', resultOfMsgInstructions);

        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE' };
    }
};
