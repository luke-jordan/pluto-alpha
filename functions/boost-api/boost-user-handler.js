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

const promisify = require('util').promisify;
const redisDel = promisify(redis.del).bind(redis);
const redisSet = promisify(redis.set).bind(redis);
const redisGet = promisify(redis.get).bind(redis);

const redisGetParsed = async (cacheKey) => {
    const cacheResult = await redisGet(cacheKey);
    logger('Got result from cache: ', cacheResult);
    if (typeof cacheResult === 'string' && cacheResult.length > 0) {
        return JSON.parse(cacheResult);
    }

    return null;
};

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
    
    if (typeof params.numberTaps === 'number') {
        gameLogContext.numberTaps = params.numberTaps;
    }

    if (typeof params.percentDestroyed === 'number') {
        gameLogContext.percentDestroyed = params.percentDestroyed;
    }

    const boostLog = { boostId: boost.boostId, accountId, logType: 'GAME_RESPONSE', logContext: gameLogContext };
    await persistence.insertBoostAccountLogs([boostLog]);
};

const generateUpdateInstruction = ({ boostId, statusResult, accountId, boostAmount }) => {
    logger('Generating update instructions, with status results: ', statusResult);
    const highestStatus = statusResult.sort(util.statusSorter)[0];
    
    const logContext = { newStatus: highestStatus, boostAmount };

    return {
        boostId,
        accountIds: [accountId],
        newStatus: highestStatus,
        logType: 'STATUS_CHANGE',
        logContext
    };
};

const expireGame = async (sessionId) => {
    logger('Ending game:', sessionId);
    return redisDel(`${config.get('cache.prefix.gameSession')}::${sessionId}`);
};

const fetchFinalScore = async (sessionId, finalScore = null) => {
    const cachedGameSession = await redisGetParsed(`${config.get('cache.prefix.gameSession')}::${sessionId}`);
    logger('Fetching final score from: ', cachedGameSession);

    const sessionGameResults = cachedGameSession.gameEvents;
    const { numberTaps } = sessionGameResults[sessionGameResults.length - 1];
    logger('Last cached score: ', numberTaps);
    
    const maxTapsPerInterval = config.get('gameSession.maxTapsPerInterval');
    if (finalScore && (finalScore - numberTaps) > maxTapsPerInterval) {
        throw new Error('Inconsistent final score');
    }

    return finalScore ? finalScore : numberTaps;
};

const fetchBoostFromCacheOrDB = async (boostId) => {
    const cacheKey = `${config.get('cache.prefix.gameBoost')}::${boostId}`;
    const cachedBoost = await redisGetParsed(cacheKey);
    logger('Got cached game boost: ', cachedBoost);
    if (cachedBoost) {
        cachedBoost.boostEndTime = moment(cachedBoost.boostEndTime);
        return cachedBoost;
    }

    const boost = await persistence.fetchBoost(boostId);
    logger('Got boost from persistence: ', boost);

    boost.boostEndTime = moment(boost.boostEndTime);
    await redisSet(cacheKey, JSON.stringify(boost), 'EX', config.get('cache.ttl.gameBoost'));

    return boost;
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
        const { boostId, sessionId, eventType, numberTaps } = params;

        if (sessionId) {
            params.numberTaps = await fetchFinalScore(sessionId, numberTaps);
            await expireGame(sessionId);
        }

        // todo : make sure boost is available for this account ID
        const [boost, accountId] = await Promise.all([
            fetchBoostFromCacheOrDB(boostId), 
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
        let boostAmount = boost.boostAmount;

        if (statusResult.includes('REDEEMED')) {
            // do this first, as if it fails, we do not want to proceed
            const redemptionCall = { redemptionBoosts: [boost], affectedAccountsDict: accountDict, event: { accountId, eventType }};
            resultOfTransfer = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
            logger('Boost process-redemption, result of transfer: ', resultOfTransfer);
            boostAmount = resultOfTransfer[boostId].boostAmount;
        }

        if (resultOfTransfer[boostId] && resultOfTransfer[boostId].result !== 'SUCCESS') {
            throw Error('Error transferring redemption');
        }

        const updateInstruction = generateUpdateInstruction({ boostId, statusResult, accountId, boostAmount });
        logger('Sending this update instruction to persistence: ', updateInstruction);
        
        const adjustedLogContext = { ...updateInstruction.logContext, processType: 'USER', submittedParams: params };
        updateInstruction.logContext = adjustedLogContext;
        
        const resultOfUpdates = await persistence.updateBoostAccountStatus([updateInstruction]);
        logger('Result of update operation: ', resultOfUpdates);
   
        if (statusResult.includes('REDEEMED')) {
            resultBody.amountAllocated = { amount: boostAmount, unit: boost.boostUnit, currency: boost.boostCurrency };
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

const handleGameInitialisation = async (boostId, systemWideUserId) => {
    logger('Initialising game for boost id: ', boostId, 'And user ', systemWideUserId);
    const sessionId = uuid();

    const boost = await fetchBoostFromCacheOrDB(boostId);
    logger('Got boost:', boost);

    const { timeLimitSeconds } = boost.gameParams;

    const currentTime = moment().valueOf();
    const gameEndTime = currentTime + (timeLimitSeconds * 1000);

    const gameSession = JSON.stringify({
        boostId,
        systemWideUserId,
        gameEndTime: gameEndTime,
        gameEvents: [{
            timestamp: currentTime,
            numberTaps: 0
        }]
    });

    logger('Initialised game. Sending details to cache: ', gameSession);
    const cacheKey = `${config.get('cache.prefix.gameSession')}::${sessionId}`;
    await redisSet(cacheKey, gameSession, 'EX', config.get('cache.ttl.gameSession'));

    return { statusCode: 200, body: JSON.stringify({ sessionId })};
};

const isGameFinished = (gameSession) => moment().valueOf() > gameSession.gameEndTime;

const isValidGameResult = (gameSession, currentTime) => {
    const sessionGameResults = gameSession.gameEvents;
    const mostRecentGameResult = sessionGameResults[sessionGameResults.length - 1];
    logger('Got most recent game result: ', mostRecentGameResult);

    const intervalBetweenResults = currentTime.diff(moment(mostRecentGameResult.timestamp), 'seconds');
    logger(`Interval between game results: ${intervalBetweenResults} seconds`);
    const minInterval = config.get('time.minGameResultsInterval.value');

    if (intervalBetweenResults < minInterval) {
        return false;
    }

    if (isGameFinished(gameSession)) {
        return false;
    }

    return true;
};

const handleInterimGameResult = async ({ sessionId, numberTaps }) => {
    logger('Storing interim game results in cache');
    const currentTime = moment();

    const cacheKey = `${config.get('cache.prefix.gameSession')}::${sessionId}`;
    const cachedGameSession = await redisGetParsed(cacheKey);
    logger('Got cached game session: ', cachedGameSession);

    if (!isValidGameResult(cachedGameSession, currentTime)) {
        return { statusCode: statusCodes('Bad Request') };
    }

    cachedGameSession.gameEvents.push({ timestamp: currentTime.valueOf(), numberTaps });
    logger('New game session: ', cachedGameSession);
    await redisSet(cacheKey, JSON.stringify(cachedGameSession), 'EX', config.get('cache.ttl.gameSession'));

    return { statusCode: 200, body: JSON.stringify({ result: 'SUCCESS' })};
};

module.exports.checkForHangingGame = async () => {
    const activeGames = redis.keys(`${config.get('cache.prefix.gameSession')}::*`);
    logger('Got active games:', activeGames);
    const hangingGames = activeGames.map((game) => isGameFinished(game));
    logger('Got hanging games:', hangingGames);

    if (hangingGames.length > 0) {
        const expiryPromises = hangingGames.map((game) => expireGame(game.sessionId));
        const resultOfExpiry = await Promise.all(expiryPromises);
        logger('Result of game expiry:', resultOfExpiry);
    }

    return { result: 'SUCCESS' };
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

        const params = util.extractEventBody(event);
        const { boostId, eventType } = params;

        if (eventType === 'INITIALISE') {
            return handleGameInitialisation(boostId, systemWideUserId);
        }
        
        if (eventType === 'GAME_IN_PROGRESS') {
            return handleInterimGameResult(params);
        }

        throw new Error('Unrecognized event');
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};
