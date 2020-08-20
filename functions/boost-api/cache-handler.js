'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const moment = require('moment');

const uuid = require('uuid/v4');
const statusCodes = require('statuses');

const persistence = require('./persistence/rds.boost');
const util = require('./boost.util');

const Redis = require('redis');
const redis = Redis.createClient();

const promisify = require('util').promisify;

const redisKeys = promisify(redis.keys).bind(redis);
const redisSet = promisify(redis.set).bind(redis);
const redisGet = promisify(redis.get).bind(redis);
const redisMGet = promisify(redis.mget).bind(redis);

const redisGetParsed = async (cacheKey) => {
    const cacheResult = await redisGet(cacheKey);
    logger('Got result from cache: ', cacheResult);
    if (typeof cacheResult === 'string' && cacheResult.length > 0) {
        return JSON.parse(cacheResult);
    }

    return null;
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

const handleGameInitialisation = async (boostId, systemWideUserId) => {
    logger('Initialising game for boost id: ', boostId, 'And user ', systemWideUserId);
    const sessionId = uuid();

    const boost = await fetchBoostFromCacheOrDB(boostId);
    logger('Got boost: ', boost);

    const { timeLimitSeconds } = boost.gameParams;

    const currentTime = moment().valueOf();
    const gameEndTime = currentTime + (timeLimitSeconds * 1000);

    const gameSession = JSON.stringify({
        boostId,
        systemWideUserId,
        sessionId,
        gameEndTime,
        status: 'ACTIVE',
        gameEvents: [{
            timestamp: currentTime,
            userScore: 0
        }]
    });

    logger('Initialised game session: ', gameSession);
    const cacheKey = `${config.get('cache.prefix.gameSession')}::${sessionId}`;
    await redisSet(cacheKey, gameSession, 'EX', config.get('cache.ttl.gameSession'));

    return { statusCode: 200, body: JSON.stringify({ sessionId })};
};

const isValidGameResult = (gameSession, currentTime) => {
    if (gameSession.status !== 'ACTIVE') {
        return false;
    }

    const sessionGameResults = gameSession.gameEvents;
    const mostRecentGameResult = sessionGameResults[sessionGameResults.length - 1];
    logger('Got most recent game result: ', mostRecentGameResult);

    const intervalBetweenResults = currentTime.diff(moment(mostRecentGameResult.timestamp), 'seconds');
    logger(`Interval between game results: ${intervalBetweenResults} seconds`);
    const minInterval = config.get('time.minGameResultsInterval.value');

    if (intervalBetweenResults < minInterval) {
        return false;
    }

    if (currentTime.valueOf() > gameSession.gameEndTime) {
        return false;
    }

    return true;
};

const handleInterimGameResult = async ({ sessionId, userScore }) => {
    logger('Storing interim game results in cache');
    const currentTime = moment();

    const cacheKey = `${config.get('cache.prefix.gameSession')}::${sessionId}`;
    const cachedGameSession = await redisGetParsed(cacheKey);
    logger('Got cached game session: ', cachedGameSession);

    if (!isValidGameResult(cachedGameSession, currentTime)) {
        return { statusCode: statusCodes('Bad Request') };
    }

    cachedGameSession.gameEvents.push({ timestamp: currentTime.valueOf(), userScore });
    logger('New game session: ', cachedGameSession);

    await redisSet(cacheKey, JSON.stringify(cachedGameSession), 'EX', config.get('cache.ttl.gameSession'));

    return { statusCode: 200, body: JSON.stringify({ result: 'SUCCESS' })};
};

/**
 * This function handles game session cache creation and user score updates to the cache.
 * @param {object} event 
 * @property {string} boostId The boost from which the game prize is to be awarded from.
 * @property {string} eventType Identifies the event. Valid values are INITIALISE and GAME_IN_PROGRESSS.
 * @property {string} sessionId Sent with GAME_IN_PROGRESS events. The session id returned during game initialisation.
 * @property {number} userScore Also sent with GAME_IN_PROGRESS. The users score.
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

        return { statusCode: statusCodes('Bad Request') };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};

const expireGameSession = async (gameSession) => {
    gameSession.status = 'EXPIRED';
    const cacheKey = `${config.get('cache.prefix.gameSession')}::${gameSession.sessionId}`;
    return redisSet(cacheKey, JSON.stringify(gameSession), 'EX', config.get('cache.ttl.gameSession'));
};

/**
 * This function checks for hanging expired games, i.e., games that remain in cache after their gameEndTime
 * has been exceeded. If any are found they are removed from cache.
 */
module.exports.checkForHangingGame = async () => {
    try {
        const currentTime = moment();
        const cacheKeys = await redisKeys('*');
        const sessionKeys = cacheKeys.filter((key) => key.startsWith(`${config.get('cache.prefix.gameSession')}::`));
        logger('Got session keys: ', sessionKeys);
    
        const cachedGameSessions = await redisMGet(sessionKeys);
        logger('Got cached game sessions: ', cachedGameSessions);

        const parsedGameSessions = cachedGameSessions.map((gameSession) => JSON.parse(gameSession));
        const hangingGameSessions = parsedGameSessions.filter((gameSession) => currentTime.valueOf() > gameSession.gameEndTime);
        logger('Got hanging game sessions: ', hangingGameSessions);

        if (hangingGameSessions.length > 0) {
            const expiryPromises = hangingGameSessions.map((gameSession) => expireGameSession(gameSession));
            await Promise.all(expiryPromises);
        }
    
        return { result: 'SUCCESS' };
    } catch (err) {
        return { result: 'FAILURE' };
    }
};

/**
 * This function validates a users final score or fetches it from cache.
 * @param {string} sessionId The game session id.
 * @param {number} finalScore An optional value, used in the event of a final score being presented with a USER_GAME_COMPLETION event.
 */
module.exports.fetchOrValidateFinalScore = async (sessionId, finalScore = null) => {
    const cachedGameSession = await redisGetParsed(`${config.get('cache.prefix.gameSession')}::${sessionId}`);
    logger('Fetching final score from: ', cachedGameSession);

    // Validate if finalScore is consistent with cached scores or return last cached score
    const sessionGameResults = cachedGameSession.gameEvents;
    const { userScore } = sessionGameResults[sessionGameResults.length - 1];
    logger('Last cached score: ', userScore);
    
    const maxScorePerInterval = config.get('gameSession.maxScorePerInterval');
    if (finalScore && (finalScore - userScore) > maxScorePerInterval) {
        throw new Error('Inconsistent final score');
    }

    return finalScore ? finalScore : userScore;
};
