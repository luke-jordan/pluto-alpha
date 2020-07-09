'use strict';

const logger = require('debug')('jupiter:boosts:ml');
const moment = require('moment');
const config = require('config');

const persistence = require('./persistence/rds.boost');
const tiny = require('tiny-json-http');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const triggerMsgInstructions = async (boostsAndRecipients) => {
    const instructions = boostsAndRecipients.map((boost) => ({
        instructionId: boost.instructionId,
        userIds: boost.userIds,
        parameters: boost.parameters
    }));

    const msgInstructionInvocation = {
        FunctionName: config.get('lambdas.messageSend'),
        InvocationType: 'Event',
        Payload: JSON.stringify({ instructions })
    };

    const resultOfInvocation = await lambda.invoke(msgInstructionInvocation).promise();
    logger('Raw result of msg instruction invocation: ', resultOfInvocation);
    const resultPayload = JSON.parse(resultOfInvocation['Payload']);
    return JSON.parse(resultPayload.body);
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

    const { boostId, audienceId, messageInstructionIds } = boost;
    const audienceAccountIds = await persistence.extractAccountIds(audienceId);
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

    return {
        boostId,
        parameters: boost,
        userIds: userIdsForOffering,
        accountIds: accountIdsForOffering,
        instructionId: messageInstructionIds.instructions[0].instructionId
    };
};

const createUpdateInstruction = (boostId, accountIds) => ({ boostId, accountIds, newStatus: 'OFFERED', logType: 'ML_BOOST_OFFERED' });

/**
 * A scheduled job that pulls and processes active ML boosts.
 * @param {object} event 
 */
module.exports.processMlBoosts = async (event) => {
    try {
        const boostId = event.boostId || null;
        const mlBoosts = await persistence.fetchActiveMlBoosts(boostId);
        logger('Got machine-determined boosts:', mlBoosts);

        const resultOfSelection = await Promise.all(mlBoosts.map((boost) => selectUsersForBoostOffering(boost)));
        logger('Got boosts and recipients:', resultOfSelection);

        const boostsAndRecipients = resultOfSelection.filter((result) => result.boostId && result.accountIds);
        const statusUpdateInstructions = boostsAndRecipients.map((boost) => createUpdateInstruction(boost.boostId, boost.accountIds));
        logger('Created boost status update instructions:', statusUpdateInstructions);

        const resultOfUpdate = persistence.updateBoostAccountStatus(statusUpdateInstructions);
        logger('Result of boost account status update:', resultOfUpdate);

        const resultOfMsgInstructions = await triggerMsgInstructions(boostsAndRecipients);
        logger('triggering message instructions resulted in:', resultOfMsgInstructions);

        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE' };
    }
};
