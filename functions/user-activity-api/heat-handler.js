'use strict';

const logger = require('debug')('jupiter:heat:main');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const rds = require('./persistence/rds.heat');
const publisher = require('publish-common');

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host')
});

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const profileKeyPrefix = config.get('cache.keyPrefixes.profile');
// const heatKeyPrefix = config.get('cache.keyPrefixes.savingHeat');

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////////// WRITE OPERATIONS /////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////////////
// write operation, takes a batch of user events, finds ones that have a heat attached, and write them

const obtainProfile = async (userId) => {
    const profileInvocation = {
        FunctionName: config.get('lambdas.fetchProfile'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ systemWideUserId: userId })
    };

    const profileResult = await lambda.invoke(profileInvocation).promise();
    const profilePayload = JSON.parse(profileResult.Payload);
    return JSON.parse(profilePayload.body);
};

const cacheUserProfile = async (userId) => {
    const cacheKey = `${profileKeyPrefix}::${userId}`;
    const cachedProfile = await redis.get(cacheKey); // could probably further optimize this via an mget, but trade off not worth it now
    if (typeof cachedProfile === 'string' && cachedProfile.length > 0) {
        logger('User ID: ', userId, ' already cached');
        return;
    }

    // as above, could turn this into taking userIds and so on, but this lambda fetch is one-at-a-time, so not much gain
    const userProfile = await obtainProfile(userId);
    await redis.set(cacheKey, JSON.stringify(userProfile), 'EX', config.get('cache.ttls.profile'));
    logger('Completed fetching and caching profile');
};

const assemblePointLogInsertion = async (userEvent) => {
    const { userId, eventType } = userEvent;
    const cachedProfile = await redis.get(`${profileKeyPrefix}::${userId}`);
    if (!cachedProfile) {
        logger('Error! User profile not cached');
        return null;
    }
    const { clientId, floatId } = JSON.parse(cachedProfile);
    const pointLogInsertion = await rds.obtainPointsForEvent(clientId, floatId, eventType);
    logger(`For user ${userId} and event type ${eventType}, have insertion: ${JSON.stringify(pointLogInsertion)}`);
    
    if (!pointLogInsertion) {
        return null;
    }

    // final clean up (in future may use parameters to do some further processing). for now, rds does not need event type
    // (gets it from join ID), but handy for log publishing etc
    Reflect.deleteProperty(pointLogInsertion, 'parameters');
    return { userId, eventType, ...pointLogInsertion };
};

const publishLogForPoints = async (pointLogInsertion) => {
    const context = {
        awardedForEvent: pointLogInsertion.eventType,
        numberPoints: pointLogInsertion.numberPoints
    };

    await publisher.publishUserEvent(pointLogInsertion.userId, 'HEAT_POINTS_AWARDED', { context });
};

module.exports.handleSqsBatch = async (event) => {
    try {
        const snsEvents = opsUtil.extractSQSEvents(event);
        const userEvents = snsEvents.map(opsUtil.extractSNSEvent);
        logger('Processing batch of user events: ', JSON.stringify(userEvents));
        
        const eventTypesToProcess = await rds.filterForPointRelevance(userEvents.map(({ eventType }) => eventType));
        logger('Processing event types: ', eventTypesToProcess);

        const eventsToProcess = userEvents.filter(({ eventType }) => eventTypesToProcess.includes(eventType));
        if (eventsToProcess.length === 0) {
            return { statusCode: 200, pointEventsTrigged: 0 };
        }

        // so that if we have a batch we don't end up multiplying unnecessary calls, and later calls have profiles ready
        // note ; since this cache is shared, there is little loss if we have a false positive on event to process
        const uniqueUserIds = [...new Set(eventsToProcess.map(({ userId }) => userId))];
        logger('Caching profiles for user IDs: ', uniqueUserIds);
        await Promise.all(uniqueUserIds.map(cacheUserProfile));
        
        const allAssembledInsertions = await Promise.all(eventsToProcess.map(assemblePointLogInsertion));
        const pointLogInsertions = allAssembledInsertions.filter((pointLogInsertion) => pointLogInsertion !== null);
        if (pointLogInsertions.length === 0) {
            return { statusCode: 200, pointEventsTrigged: 0 };
        }

        const resultOfInsertion = await rds.insertPointLogs(pointLogInsertions);
        if (resultOfInsertion.result === 'INSERTED') {
            await Promise.all(pointLogInsertions.map(publishLogForPoints));
            return { statusCode: 200, pointEventsTrigged: pointLogInsertions.length };
        }

        throw Error('Uncaught error in RDS processing');
    } catch (err) {
        logger('FATAL_ERROR: ', err); // so we catch this
        return { statusCode: 500, error: JSON.stringify(err) };
    }
};

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////////// READ OPERATIONS /////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////////////

// simpler form of above (in time refactor above to just this)
const fetchProfile = async (userId) => {
    const cachedProfile = await redis.get(`${profileKeyPrefix}::${userId}`);
    if (cachedProfile) {
        return JSON.parse(cachedProfile);
    }

    const fetchedProfile = await obtainProfile(userId);
    await redis.set(`${profileKeyPrefix}::${userId}`, JSON.stringify(fetchedProfile), 'EX', config.get('cache.ttls.profile'));
    return fetchedProfile;
};


const fetchHeatLevels = async (clientId, floatId) => {
    const listOfLevels = await rds.obtainPointLevels(clientId, floatId);
    logger('Fetched heat levels for client ', clientId, ' and float ', floatId, ' as: ', JSON.stringify(listOfLevels));
    if (!listOfLevels || listOfLevels.length === 0) {
        return {}; // so current level will just return blank
    }

    const normalizedLevels = listOfLevels.reduce((obj, level) => ({ ...obj, [level.minimumPoints]: level }), {});
    return normalizedLevels;
};

const findPointsForLevel = (currentPoints, heatLevels) => {
    const heatPointLevels = Object.keys(heatLevels);
    const pointsBelow = heatPointLevels.filter((minimumPoints) => minimumPoints <= currentPoints);
    return pointsBelow.length > 0 ? heatLevels[Math.max(...pointsBelow)] : null;
};

const fetchHeatForUserThemselves = async (userId, params) => {
    const { clientId, floatId } = await fetchProfile(userId);

    const start = params.startTimeMillis ? moment(params.startTimeMillis) : null;
    const end = params.endTimeMillis ? moment(params.endTimeMillis) : null;

    const [pointSum, heatLevels] = await Promise.all([
        rds.sumPointsForUsers([userId], start, end), fetchHeatLevels(clientId, floatId)
    ]);

    logger('For user ID ', userId, ' retrieved: ', pointSum);

    const currentPoints = pointSum[userId];
    const currentLevel = findPointsForLevel(currentPoints, heatLevels);

    return { statusCode: 200, body: JSON.stringify({ currentPoints, currentLevel })};
};

const extractPointAndLevel = (userId, currentPointSums, heatLevels) => {
    const currentPoints = currentPointSums[userId] || 0;
    const currentLevel = findPointsForLevel(currentPoints, heatLevels);
    return { currentPoints, currentLevel };
};

const fetchHeatForUsers = async (userIds, params) => {
    const { clientId, floatId } = params;

    const start = params.startTimeMillis ? moment(params.startTimeMillis) : null;
    const end = params.endTimeMillis ? moment(params.endTimeMillis) : null;

    const [currentPointSums, heatLevels] = await Promise.all([
        rds.sumPointsForUsers(userIds, start, end), fetchHeatLevels(clientId, floatId)
    ]);

    // as above, will be adding heat to these things
    const userPointMap = userIds.reduce((obj, userId) => ({ 
        ...obj, [userId]: extractPointAndLevel(userId, currentPointSums, heatLevels)
    }), {});

    return { statusCode: 200, body: JSON.stringify(userPointMap) };
};

module.exports.fetchUserHeat = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const isApiCall = opsUtil.isApiCall(event);

        const params = opsUtil.extractParamsFromEvent(event);
        
        if (isApiCall && !params.userIds) {
            const { systemWideUserId } = opsUtil.extractUserDetails(event);
            return fetchHeatForUserThemselves(systemWideUserId, params);
        }

        const { userIds } = params;
        return fetchHeatForUsers(userIds, params);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
};

