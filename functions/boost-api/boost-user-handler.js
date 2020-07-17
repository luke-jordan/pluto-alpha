'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const statusCodes = require('statuses');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const AWS = require('aws-sdk');

AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

const isBoostTournament = (boost) => boost.boostType === 'GAME' && boost.statusConditions.REDEEMED && 
    boost.statusConditions.REDEEMED.some((condition) => condition.startsWith('number_taps_in_first_N') || condition.startsWith('percent_destroyed_in_first_N'));

const expireTournamentIfFinished = async (boostId) => {
    const expiryInvocation = util.lambdaParameters({ boostId }, 'tournamentExpiry', false);
    const resultOfInvocation = await lambda.invoke(expiryInvocation).promise();
    logger('Result of invocation: ', resultOfInvocation);

    const resultPayload = JSON.parse(resultOfInvocation['Payload']);
    const resultBody = JSON.parse(resultPayload.body);

    return resultBody;
};

const recordGameResult = async (params, boost, accountId) => {
    const gameLogContext = { 
        timeTakenMillis: params.timeTakenMillis 
    };
    
    if (params.numberTaps) {
        gameLogContext.numberTaps = params.numberTaps;
    }

    if (params.percentDestroyed) {
        gameLogContext.percentDestroyed = params.percentDestroyed;
    }

    const boostLog = { boostId: boost.boostId, accountId, logType: 'GAME_RESPONSE', logContext: gameLogContext };
    await persistence.insertBoostAccountLogs([boostLog]);
};

const generateUpdateInstruction = (boost, statusResult, accountId) => {
    logger('Generating update instructions, with status results: ', statusResult);
    const boostId = boost.boostId;
    const highestStatus = statusResult.sort(util.statusSorter)[0];
    
    const logContext = { newStatus: highestStatus, boostAmount: boost.boostAmount };

    return {
        boostId,
        accountIds: [accountId],
        newStatus: highestStatus,
        logType: 'STATUS_CHANGE',
        logContext
    };
};


/**
 * @param {object} event The event from API GW. Contains a body with the parameters:
 * @property {number} numberTaps The number of taps (if a boost game)
 * @property {number} percentDestroyed The amount of the image/screen 'destroyed' (for that game)
 * @property {number} timeTaken The amount of time taken to complete the game (in seconds)  
 */
module.exports.processUserBoostResponse = async (event) => {
    try {        
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: statusCodes('Forbidden') };
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
        logger('Relevant account ID: ', accountId);

        const boostAccountJoin = await persistence.fetchCurrentBoostStatus(boostId, accountId);
        logger('And current boost status: ', boostAccountJoin);
        if (!boostAccountJoin) {
            return { statusCode: statusCodes('Bad Request'), body: JSON.stringify({ message: 'User is not offered this boost' }) };
        }

        const { boostStatus: currentStatus } = boostAccountJoin;
        const allowableStatus = ['CREATED', 'OFFERED', 'UNLOCKED']; // as long as not redeemed or pending, status check will do the rest
        if (!allowableStatus.includes(currentStatus)) {
            return { statusCode: statusCodes('Bad Request'), body: JSON.stringify({ message: 'Boost is not unlocked', status: currentStatus }) };
        }

        const statusEvent = { eventType, eventContext: params };
        const statusResult = conditionTester.extractStatusChangesMet(statusEvent, boost);

        if (boost.boostType === 'GAME' && eventType === 'USER_GAME_COMPLETION') {
            await recordGameResult(params, boost, accountId);
        }
        
        if (statusResult.length === 0) {
            if (isBoostTournament(boost)) {
                await expireTournamentIfFinished(boost.boostId);
                return { statusCode: 200, body: JSON.stringify({ result: 'TOURNAMENT_ENTERED', endTime: boost.boostEndTime.valueOf() }) };
            }
            return { statusCode: 200, body: JSON.stringify({ result: 'NO_CHANGE' })};
        }

        const accountDict = { [boostId]: { [accountId]: { userId: systemWideUserId } }};

        const resultBody = { result: 'TRIGGERED', statusMet: statusResult, endTime: boost.boostEndTime.valueOf() };

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

        const updateInstruction = generateUpdateInstruction(boost, statusResult, accountId);
        logger('Sending this update instruction to persistence: ', updateInstruction);
        
        const adjustedLogContext = { ...updateInstruction.logContext, processType: 'USER', submittedParams: params };
        updateInstruction.logContext = adjustedLogContext;
        
        const resultOfUpdates = await persistence.updateBoostAccountStatus([updateInstruction]);
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
        logger('FATAL_ERROR: ', err);
        return { statusCode: statusCodes('Internal Server Error'), body: JSON.stringify(err.message) };
    }
};
