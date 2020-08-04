'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const moment = require('moment');

const uuid = require('uuid/v4');
const statusCodes = require('statuses');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const AWS = require('aws-sdk');

AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

const Redis = require('redis');
const redis = Redis.createClient();

const expireFinishedTournaments = async (boost) => {
    // for now, we only care enough if this is a friend tournament
    const flags = boost.flags || []; // just as even small chance of accidental fragility here would be a really bad trade-off
    if (!util.isBoostTournament(boost) || !flags.includes('FRIEND_TOURNAMENT')) {
        return;
    }

    // the expiry handler will take care of the checks to see if everyone else has played, and if so, will end this
    logger('Telling boost expiry to check ...');
    const expiryInvocation = util.lambdaParameters({}, 'boostExpire', false);
    await lambda.invoke(expiryInvocation).promise();
    logger('Dispatched');
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
            // only a malformed tournament would have no status change when user plays, but just in case
            const returnResult = util.isBoostTournament(boost) ? { result: 'TOURNAMENT_ENTERED', endTime: boost.boostEndTime.valueOf() } : { result: 'NO_CHANGE' };
            return { statusCode: 200, body: JSON.stringify(returnResult)};
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

        if (statusResult.includes('PENDING')) {
            await expireFinishedTournaments(boost);
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

const fetchBoostFromCacheOrDB = async (boostId) => {
    const cacheKey = `${config.get('cache.prefix.gameBoost')}::${boostId}`;

    const cacheResult = await redis.get(cacheKey);
    logger('Got cached game boost: ', cacheResult);
    if (typeof cacheResult === 'string' && cacheResult.length > 0) {
        return JSON.parse(cacheResult);
    }

    const boost = await persistence.fetchBoost(boostId);
    logger('Got boost from persistence: ', boost);
    await redis.set(cacheKey, JSON.stringify(boost), 'EX', config.get('cache.ttl.gameBoost'));

    return boost;
};

const handleGameInitialisation = async (boostId, systemWideUserId) => {
    logger('Initialising game for boost id: ', boostId, 'And user ', systemWideUserId)
    const sessionId = uuid();

    const boost = await fetchBoostFromCacheOrDB(boostId);
    logger('Got boost:', boost);

    const { timeLimitSeconds } = boost.gameParams;

    const currentTime = moment().valueOf();
    const gameEndTime = currentTime + (timeLimitSeconds * 1000);

    const gameState = JSON.stringify({
        boostId,
        systemWideUserId,
        gameEndTime,
        [sessionId]: [{ timestamp: currentTime, userScore: 0 }]
    });

    logger('Initialised game. Sending details to cache: ', gameState);
    const cacheKey = `${config.get('cache.prefix.gameSession')}::${sessionId}`;
    await redis.set(cacheKey, gameState, 'EX', config.get('cache.ttl.gameSession'));

    return { statusCode: 200, body: JSON.stringify({ sessionId })};
};

const hasValidInterval = (sessionId, gameState) => {
    const sessionGameResults = gameState[sessionId];
    const mostRecentGameResult = sessionGameResults[sessionGameResults.length -1]
    logger('Got most recent game result: ', mostRecentGameResult)
    const intervalBetweenResults = moment().diff(moment(mostRecentGameResult.timestamp), 'seconds');
    logger(`Interval between game results: ${intervalBetweenResults} seconds`);

    return intervalBetweenResults >= config.get('time.minGameResultsInterval.value');
}

const handleInterimGameResult = async (sessionId, currentTime, currentScore) => {
    logger('Storing interim game results in cache');
    const cacheKey = `${config.get('cache.prefix.gameSession')}::${sessionId}`;
    const cacheResult = await redis.get(cacheKey);
    const cachedGameState = JSON.parse(cacheResult);
    logger('Got cached game state: ', cachedGameState);

    if (!hasValidInterval(sessionId, cachedGameState)) {
        return { statusCode: statusCodes('Forbidden') };
    }

    cachedGameState[sessionId].push({
        timestamp: currentTime,
        userScore: currentScore
    });
    logger('New game state: ', cachedGameState);
    await redis.set(cacheKey, JSON.stringify(cachedGameState), 'EX', config.get('cache.ttl.gameSession'));

    return { statusCode: 200, body: JSON.stringify({ result: 'SUCCESS' })};
};

/**
 * 
 * @param {object} event 
 */
module.exports.cacheGameResponse = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: statusCodes('Forbidden') };
        }

        const { systemWideUserId } = userDetails;
        const { boostId, eventType, gameLogContext } = util.extractEventBody(event);

        if (eventType === 'INITIALISE') {
            return handleGameInitialisation(boostId, systemWideUserId);
        }
        
        if (eventType === 'GAME_IN_PROGRESS') {
            const currentTime = moment().valueOf();
            const { sessionId, currentScore } = gameLogContext;
            return handleInterimGameResult(sessionId, currentTime, currentScore);
        }

        if (eventType === 'USER_GAME_COMPLETION') {
            // consolidate cached game score
            // handle winning user or loser
            // return final score and result
        }
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};
