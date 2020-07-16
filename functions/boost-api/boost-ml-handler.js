'use strict';

const logger = require('debug')('jupiter:boosts:ml');
const moment = require('moment');
const config = require('config');

const tiny = require('tiny-json-http');
const util = require('ops-util-common');

const persistence = require('./persistence/rds.boost');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const invokeLambda = async (functionName, payload, async = false) => {
    const invocation = {
        FunctionName: functionName,
        InvocationType: async ? 'Event' : 'RequestResponse',
        Payload: JSON.stringify(payload)
    };

    const resultOfInvocation = await lambda.invoke(invocation).promise();
    logger(`Raw result of ${functionName} invocation: `, resultOfInvocation);
    const resultPayload = JSON.parse(resultOfInvocation['Payload']);
    return JSON.parse(resultPayload.body);
};

const assembleListOfMsgInstructions = ({ userIds, instructionIds, parameters }) => userIds.
    map((destinationUserId) => instructionIds.
    map((instructionId) => ({ instructionId, destinationUserId, parameters }))).
    reduce((assembledInstructions, instruction) => [...assembledInstructions, ...instruction]);

const triggerMsgInstructions = async (boostsAndRecipients) => {
    logger('Assembling instructions from:', boostsAndRecipients);
    const instructions = boostsAndRecipients.map((boostDetails) => assembleListOfMsgInstructions(boostDetails))[0];
    logger('Assembled instructions:', instructions);
    return invokeLambda(config.get('lambdas.messageSend'), { instructions });
};

const sendRequestToRefreshAudience = async (audienceId) => {
    logger('Refreshing audience:', audienceId);
    const audiencePayload = { operation: 'refresh', params: { audienceId } };
    return invokeLambda(config.get('lambdas.audienceHandle'), audiencePayload, true);
};

const obtainUsersForOffering = async (boost, userIds) => {
    const data = {
        'candidate_users': userIds,
        'boost_parameters': {
            'boost_type_category': `${boost.boostType}::${boost.boostCategory}`,
            'boost_amount_whole_currency': util.convertToUnit(boost.boostAmount, boost.boostUnit, 'WHOLE_CURRENCY')
        }
    }
    // need authentication too
    const options = { url: config.get('mlSelection.endpoint'), data };
    const result = await tiny.post(options);
    logger('Result of ml boost user selection:', result);
    const userIdsToOffer = result.filter((decision) => decision['should_offer']).map((decision) => decision['user_id']);
    logger('Extracted IDs to offer: ', userIdsToOffer);
    return userIdsToOffer;
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

const selectUsersForBoostOffering = async (boost, persistence) => {
    await sendRequestToRefreshAudience(boost.audienceId);

    const { boostId, audienceId, messageInstructionIds } = boost;

    const audienceAccountIds = await persistence.extractAccountIds(audienceId);
    logger('Got audience account ids:', audienceAccountIds);
    const filteredAccountIds = await filterAccountIds(boost, audienceAccountIds);
    logger('Got filtered account ids:', filteredAccountIds);

    if (filteredAccountIds.length === 0) {
        return { message: `No valid accounts found for ML boost: ${boostId}` };
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
        accountIds: accountIdsForOffering,
        userIds: userIdsForOffering,
        instructionIds,
        parameters: boost
    };
};

const createUpdateInstruction = (boostId, accountIds) => ({ boostId, accountIds, newStatus: 'OFFERED', logType: 'ML_BOOST_OFFERED' });

/**
 * A scheduled job that pulls and processes active ML boosts.
 * @param {object} boostId Optional, restricts processing to this boost
 */
module.exports.processMlBoosts = async (event, persistence) => {
    try {
        // for the moment, just allow via scheduled or manual -- in time, will allow from button on admin panel
        if (util.isApiCall()) {
            return { statusCode: 403 }
        }

        if (!config.get('mlSelection.enabled')) {
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

        const resultOfMsgInstructions = await triggerMsgInstructions(boostsAndRecipients);
        logger('triggering message instructions resulted in:', resultOfMsgInstructions);

        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE' };
    }
};
