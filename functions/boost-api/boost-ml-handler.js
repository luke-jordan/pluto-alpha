'use strict';

const logger = require('debug')('jupiter:boosts:ml');
const moment = require('moment');
const config = require('config');
const tiny = require('tiny-json-http');

const persistence = require('./persistence/rds.boost');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const assembleListOfMsgInstructions = ({ userIds, instructionIds, parameters }) => userIds.
    map((destinationUserId) => instructionIds.
    map((instructionId) => ({ instructionId, destinationUserId, parameters }))).
    reduce((assembledInstructions, instruction) => [...assembledInstructions, ...instruction]);

const triggerMsgInstructions = async (boostsAndRecipients) => {
    logger('Assembling instructions from:', boostsAndRecipients);
    const instructions = boostsAndRecipients.map((boostDetails) => assembleListOfMsgInstructions(boostDetails))[0];
    logger('Assembled instructions:', instructions);

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
    const options = { url: config.get('mlSelection.endpoint'), data: { boost, userIds } };
    const result = await tiny.get(options);
    logger('Result of ml boost user selection:', result);
    return result;
};

const hasValidMinInterval = (lastOfferedTime, minInterval) => {
    const currentInterval = moment().diff(moment(lastOfferedTime), minInterval.unit);
    logger(`Interval between last boost and now is: ${currentInterval} ${minInterval.unit}`);
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
    const boostLogsWithValidIntervals = boostLogs.filter((boostLog) => hasValidMinInterval(boostLog.creationTime, minIntervalBetweenRuns));
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
    const instructionIds = messageInstructionIds.instructions.map((instruction) => instruction.instructionId);

    return {
        boostId,
        parameters: boost,
        userIds: userIdsForOffering,
        accountIds: accountIdsForOffering,
        instructionIds
    };
};

const createUpdateInstruction = (boostId, accountIds) => ({ boostId, accountIds, newStatus: 'OFFERED', logType: 'ML_BOOST_OFFERED' });

/**
 * A scheduled job that pulls and processes active ML boosts.
 * @param {object} event 
 */
module.exports.processMlBoosts = async (event) => {
    try {
        if (!config.get('mlSelection.enabled')) { // todo: create config var
            return { result: 'NOT_ENABLED' };
        }

        const boostId = event.boostId || null;
        const mlBoosts = await persistence.fetchActiveMlBoosts(boostId);
        logger('Got machine-determined boosts:', mlBoosts);

        const resultOfSelection = await Promise.all(mlBoosts.map((boost) => selectUsersForBoostOffering(boost)));
        logger('Got boosts and recipients:', resultOfSelection);

        const boostsAndRecipients = resultOfSelection.filter((result) => result.boostId && result.accountIds);
        const statusUpdateInstructions = boostsAndRecipients.map((boost) => createUpdateInstruction(boost.boostId, boost.accountIds));
        logger('Created boost status update instructions:', statusUpdateInstructions);

        const resultOfUpdate = await persistence.updateBoostAccountStatus(statusUpdateInstructions);
        logger('Result of boost account status update:', resultOfUpdate);

        // const msgInstructionPromises = boostsAndRecipients.map((boost) => triggerMsgInstructions(boost));
        const resultOfMsgInstructions = await triggerMsgInstructions(boostsAndRecipients);
        logger('triggering message instructions resulted in:', resultOfMsgInstructions);

        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE' };
    }
};