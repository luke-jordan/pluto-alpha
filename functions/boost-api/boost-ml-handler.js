'use strict';

const logger = require('debug')('jupiter:boosts:ml');
const moment = require('moment');
const config = require('config');

const tiny = require('tiny-json-http');
const util = require('ops-util-common');
const boostUtil = require('./boost.util');

const persistence = require('./persistence/rds.boost');

const AWS = require('aws-sdk');
const { publishMultiUserEvent } = require('publish-common');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const invokeLambda = async (payload, functionKey, sync = false) => {
    const invocation = boostUtil.lambdaParameters(payload, functionKey, sync);
    const resultOfInvocation = await lambda.invoke(invocation).promise();
    logger(`Raw result of ${functionKey} invocation: `, resultOfInvocation);
};

const assembleListOfMsgInstructions = ({ userIds, instructionIds, parameters }) => userIds.
    map((destinationUserId) => instructionIds.
        map((instructionId) => ({ instructionId, destinationUserId, parameters }))).
    reduce((assembledInstructions, instruction) => [...assembledInstructions, ...instruction]);

const triggerMsgInstructions = async (boostsAndRecipients) => {
    const instructions = boostsAndRecipients.map((boostDetails) => assembleListOfMsgInstructions(boostDetails))[0];
    logger(`Assembled ${instructions.length} instructions, first one: `, instructions[0]);
    return invokeLambda({ instructions }, 'messageSend');
};

const sendRequestToRefreshAudience = async (audienceId) => {
    logger('Refreshing audience:', audienceId);
    const audiencePayload = { operation: 'refresh', params: { audienceId } };
    return invokeLambda(audiencePayload, 'audienceHandle', true);
};

const obtainUsersForOffering = async (boost, userIds) => {
    const data = {
        'candidate_users': userIds,
        'boost_parameters': {
            'boost_type_category': `${boost.boostType}::${boost.boostCategory}`,
            'boost_amount_whole_currency': util.convertToUnit(boost.boostAmount, boost.boostUnit, 'WHOLE_CURRENCY')
        }
    };
    // need authentication too
    logger('Dispatching options to ML selection service: ', JSON.stringify(data, null, 2));
    const options = { url: config.get('mlSelection.endpoint'), data };
    const result = await tiny.post(options);
    logger('Result of ml boost user selection:', JSON.stringify(result));
    const parsedResult = JSON.parse(result.body);
    const userIdsToOffer = parsedResult.filter((decision) => decision['should_offer']).map((decision) => decision['user_id']);
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

const extractAccountsMeetingInterval = (accountIds, logMap, minIntervalBetweenRuns) => {
    const hasBeenOffered = (accountId) => logMap[accountId] && logMap[accountId].creationTime;
    const hasMinInterval = (accountId) => hasValidMinInterval(logMap[accountId].creationTime, minIntervalBetweenRuns);
    return accountIds.filter((accountId) => !hasBeenOffered(accountId) || hasMinInterval(accountId));
};

const filterAccountIds = async (boostId, mlParameters, accountIds) => {
    const { onlyOfferOnce, minIntervalBetweenRuns } = mlParameters;

    if (!onlyOfferOnce && !minIntervalBetweenRuns) {
        return accountIds;
    }

    if (onlyOfferOnce) {
        const accountStatusMap = await persistence.findAccountsForBoost({ boostIds: [boostId], accountIds });
        const boostAccountStatuses = accountStatusMap[0].accountUserMap; // as usual with this function, built for too much parallelism
        logger('Got boost account statuses: ', JSON.stringify(boostAccountStatuses));
        return Object.keys(boostAccountStatuses).filter((accountId) => boostAccountStatuses[accountId].status === 'CREATED');
    }

    const boostLogPromises = accountIds.map((accountId) => persistence.findLastLogForBoost(boostId, accountId, 'ML_BOOST_OFFERED'));
    const boostLogs = await Promise.all(boostLogPromises);
    logger('Got boost logs:', boostLogs);
    const logMap = accountIds.reduce((obj, accountId, index) => ({ ...obj, [accountId]: boostLogs[index] }), {});
    return extractAccountsMeetingInterval(accountIds, logMap, minIntervalBetweenRuns);
};

const selectUsersForBoostOffering = async (boost) => {
    await sendRequestToRefreshAudience(boost.audienceId);

    const { boostId, audienceId, messageInstructions, mlParameters, expiryParameters } = boost;

    const audienceAccountIds = await persistence.extractAccountIds(audienceId);
    logger('Got audience account ids:', audienceAccountIds);

    const filteredAccountIds = await filterAccountIds(boostId, mlParameters, audienceAccountIds);
    logger('Got filtered account ids:', filteredAccountIds);

    if (filteredAccountIds.length === 0) {
        return { message: `No valid accounts found for ML boost: ${boostId}` };
    }

    const accountUserIdMap = await persistence.findUserIdsForAccounts(filteredAccountIds, true);
    logger('Got user ids for accounts:', accountUserIdMap);
    
    const userIdsFromMl = await obtainUsersForOffering(boost, Object.values(accountUserIdMap));
    if (userIdsFromMl.length === 0) {
        return { message: `No users selected for boost: ${boostId}` };
    }
    
    let maxNumberToOffer = userIdsFromMl.length;
    if (mlParameters.maxUsersPerOfferRun) {
        const { basis, value } = mlParameters.maxUsersPerOfferRun;
        maxNumberToOffer = basis === 'PROPORTION' ? Math.floor(value * audienceAccountIds.length) : value;
        logger('Restricting offer to only', maxNumberToOffer, 'users');
    }

    const userIdsForOffering = userIdsFromMl.slice(0, maxNumberToOffer);
    const accountIdsForOffering = filteredAccountIds.filter((accountId) => userIdsForOffering.includes(accountUserIdMap[accountId]));
    
    // not the most pleasant on the eye but just ensuring some robustness to malformed boosts getting in
    const defaultUntilExpiry = config.get('time.offerToExpiryDefault');
    const timeUntilExpiry = expiryParameters ? (expiryParameters.timeUntilExpiry || defaultUntilExpiry) : defaultUntilExpiry;
    
    logger('Now extracting instruction IDs from: ', messageInstructions);
    const instructionIds = messageInstructions 
        ? messageInstructions.filter(({ status }) => status === 'OFFERED').map(({ msgInstructionId }) => msgInstructionId) : [];

    return {
        boostId,
        accountIds: accountIdsForOffering,
        userIds: userIdsForOffering,
        expiryTime: moment().add(timeUntilExpiry.value, timeUntilExpiry.unit),
        instructionIds,
        parameters: boost
    };
};

const createUpdateInstruction = ({ boostId, accountIds, expiryTime }) => (
    { boostId, accountIds, newStatus: 'OFFERED', expiryTime, logType: 'ML_BOOST_OFFERED' }
);

/**
 * A scheduled job that pulls and processes active ML boosts.
 * @param {object} boostId Optional, restricts processing to this boost
 */
module.exports.processMlBoosts = async (event) => {
    try {
        // for the moment, just allow via scheduled or manual -- in time, will allow from button on admin panel
        if (util.isApiCall(event)) {
            return { statusCode: 403 };
        }

        if (!config.get('mlSelection.enabled')) {
            return { result: 'NOT_ENABLED' };
        }

        const boostId = event.boostId || null;
        const mlBoosts = await (boostId ? [persistence.fetchBoost(boostId)] : persistence.fetchActiveMlBoosts());
        logger('Got machine-determined boosts:', JSON.stringify(mlBoosts, null, 2));

        if (!mlBoosts || mlBoosts.length === 0) {
            return { result: 'NO_ML_BOOSTS' };
        }

        const resultOfSelection = await Promise.all(mlBoosts.map((boost) => selectUsersForBoostOffering(boost)));
        logger('Got boosts and recipients:', resultOfSelection);

        const filteredSelectionResult = resultOfSelection.filter((result) => result.boostId && result.accountIds);
        if (filteredSelectionResult.length === 0) {
            return { result: 'NO_SELECTIONS' };
        }

        const statusUpdateInstructions = filteredSelectionResult.map((selectionResult) => createUpdateInstruction(selectionResult));
        logger('Created boost status update instructions:', statusUpdateInstructions);

        const resultOfUpdate = await persistence.updateBoostAccountStatus(statusUpdateInstructions);
        logger('Result of boost account status update:', resultOfUpdate);

        const resultOfMsgInstructions = await triggerMsgInstructions(filteredSelectionResult);
        logger('triggering message instructions resulted in:', resultOfMsgInstructions);

        const findBoost = (soughtBoostId) => mlBoosts.find((boost) => boost.boostId === soughtBoostId);
        
        const publishPromises = filteredSelectionResult.map((result) => {
            const boost = findBoost(result.boostId);
            const context = boostUtil.constructBoostContext(boost);
            const eventType = `BOOST_OFFERED_${boost.boostType}`;
            return publishMultiUserEvent(result.userIds, eventType, { context, initiator: 'BOOST_TARGET_MODEL' });
        });

        await Promise.all(publishPromises);

        const offersMade = resultOfSelection.reduce((sum, selection) => sum + selection.accountIds.length, 0);
        return { result: 'SUCCESS', boostsProcessed: mlBoosts.length, offersMade };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE' };
    }
};
