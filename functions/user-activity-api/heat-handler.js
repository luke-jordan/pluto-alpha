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

const putUserInCacheAndStateTable = async (userId) => {
    await Promise.all([cacheUserProfile(userId), rds.establishUserState(userId)]);
};

const assemblePointLogInsertion = async (userEvent) => {
    const { userId, eventType, timestamp } = userEvent;
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
    // (gets it from join ID), but handy for log publishing etc, and we want to include a reference time seperate to log creation time

    pointLogInsertion.referenceTime = timestamp ? moment(timestamp).format() : moment().format();
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

// utility method
const extractClientFloatString = ({ clientId, floatId }) => `${clientId}::${floatId}`;

// bit of overkill as little chance of more than 1 or 2 client-floats at a time, but otherwise could become a real snarl up at scale
const obtainHeatLevels = async (userIds) => {
    // first we extract unique client float IDs (usually order of magnitude less than any volume of user Ids)
    const userProfilesRaw = await redis.mget(userIds.map((userId) => `${profileKeyPrefix}::${userId}`));
    const userProfiles = userProfilesRaw.map(JSON.parse);
    const uniqueClientFloats = [... new Set(userProfiles.map(extractClientFloatString))]
        .map((jointPair) => ({ clientId: jointPair.split('::')[0], floatId: jointPair.split('::')[1] }));
    logger('For user IDs: ', userIds, ' have client float pairs: ', JSON.stringify(uniqueClientFloats));
    
    // then we assemble a map of client ID and float ID to heat levels
    const heatLevels = await Promise.all(uniqueClientFloats.map(({ clientId, floatId }) => rds.obtainPointLevels(clientId, floatId)));
    const levelMap = uniqueClientFloats.reduce((obj, clientFloat, index) => ({ ...obj, [extractClientFloatString(clientFloat)]: heatLevels[index] }), {});
    logger('Obtained resulting map of heat levels: ', JSON.stringify(levelMap));
    
    // then we attach that to user ID and return
    const userClientFloatMap = userProfiles.reduce((obj, profile) => ({ ...obj, [profile.systemWideUserId]: extractClientFloatString(profile) }), {});
    const attachHeatLevels = (userId) => levelMap[userClientFloatMap[userId]];
    return userIds.reduce((obj, userId) => ({ ...obj, [userId]: attachHeatLevels(userId) }), {});
};

const assembleUpdateStateCall = (userId, priorPeriodMap, currentPeriodMap, heatLevelMap) => {
    const priorPeriodPoints = priorPeriodMap[userId] || 0;
    const currentPeriodPoints = currentPeriodMap[userId] || 0;

    const levelDefinitions = heatLevelMap[userId];
    const currentLevel = findLevelForPoints(Math.max(priorPeriodPoints, currentPeriodPoints), levelDefinitions);
    const currentLevelId = currentLevel ? currentLevel.levelId : null;

    return { systemWideUserId: userId, priorPeriodPoints, currentPeriodPoints, currentLevelId };
}

// candidate for future optimization but is always going to be heavy (and hence doing it on background job and making easily available)
const updateUserStates = async (pointLogInsertionsCompleted) => {
    const userIds = [...new Set(pointLogInsertionsCompleted.map(({ userId }) => userId))];

    const refMomentLastPeriod = moment().subtract(1, 'month');
    const refMomentThisPeriod = moment();

    const [priorPeriodPoints, currentPeriodPoints, heatLevels] = await Promise.all([
        rds.sumPointsForUsers(userIds, refMomentLastPeriod.startOf('month'), refMomentLastPeriod.endOf('month')),
        rds.sumPointsForUsers(userIds, refMomentThisPeriod.startOf('month')), // i.e., up until now
        obtainHeatLevels(userIds)
    ]);

    const updateCalls = userIds.map((userId) => assembleUpdateStateCall(userId, priorPeriodPoints, currentPeriodPoints, heatLevels));
    logger('Assembled update calls: ', updateCalls);

    const updateResults = await Promise.all(updateCalls.map(rds.updateUserState));
    logger('Results of update calls: ', updateResults);
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
        await Promise.all(uniqueUserIds.map(putUserInCacheAndStateTable));
        
        const allAssembledInsertions = await Promise.all(eventsToProcess.map(assemblePointLogInsertion));
        const pointLogInsertions = allAssembledInsertions.filter((pointLogInsertion) => pointLogInsertion !== null);
        if (pointLogInsertions.length === 0) {
            return { statusCode: 200, pointEventsTrigged: 0 };
        }

        const resultOfInsertion = await rds.insertPointLogs(pointLogInsertions);
        if (resultOfInsertion.result === 'INSERTED') {
            // finally, publish events, and update user state
            await Promise.all([...pointLogInsertions.map(publishLogForPoints), updateUserStates(pointLogInsertions)]);
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


const normalizeHeatLevels = (listOfLevels) => {
    if (!listOfLevels || listOfLevels.length === 0) {
        return {}; // so current level will just return blank
    }

    const normalizedLevels = listOfLevels.reduce((obj, level) => ({ ...obj, [level.minimumPoints]: level }), {});
    return normalizedLevels;
};

const findLevelForPoints = (currentPoints, listOfLevels) => {
    const heatLevels = normalizeHeatLevels(listOfLevels); // makes following steps a bit easier
    const heatPointLevels = Object.keys(heatLevels);
    const pointsBelow = heatPointLevels.filter((minimumPoints) => minimumPoints <= currentPoints);
    return pointsBelow.length > 0 ? heatLevels[Math.max(...pointsBelow)] : null;
};

const fetchHeatForUserThemselves = async (userId, params) => {
    const { clientId, floatId } = await fetchProfile(userId);

    const start = params.startTimeMillis ? moment(params.startTimeMillis) : null;
    const end = params.endTimeMillis ? moment(params.endTimeMillis) : null;

    const [pointSum, listOfLevels] = await Promise.all([
        rds.sumPointsForUsers([userId], start, end), rds.obtainPointLevels(clientId, floatId)
    ]);

    logger('For user ID ', userId, ' retrieved point sum: ', pointSum);
    logger('Fetched heat levels for client ', clientId, ' and float ', floatId, ' as: ', JSON.stringify(listOfLevels));

    const currentPoints = pointSum[userId] || 0;
    const currentLevel = findLevelForPoints(currentPoints, listOfLevels);

    return { currentPoints, currentLevel };
};

const extractPointAndLevel = (userId, currentPointSums, listOfLevels) => {
    const currentPoints = currentPointSums[userId] || 0;
    const currentLevel = findLevelForPoints(currentPoints, listOfLevels);
    return { currentPoints, currentLevel };
};

const fetchHeatForUsers = async (userIds, params) => {
    const { clientId, floatId } = params;

    const start = params.startTimeMillis ? moment(params.startTimeMillis) : null;
    const end = params.endTimeMillis ? moment(params.endTimeMillis) : null;

    const [currentPointSums, listOfLevels] = await Promise.all([
        rds.sumPointsForUsers(userIds, start, end), rds.obtainPointLevels(clientId, floatId)
    ]);

    // as above, will be adding heat to these things
    const userPointMap = userIds.reduce((obj, userId) => ({ 
        ...obj, [userId]: extractPointAndLevel(userId, currentPointSums, listOfLevels)
    }), {});

    return userPointMap;
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
            // note: if return the promise directly, lambda runtime does not wrap properly, so errors propagate incorrectly
            const returnBody = await fetchHeatForUserThemselves(systemWideUserId, params);
            return { statusCode: 200, body: JSON.stringify(returnBody) };
        }

        const { userIds } = params;
        const userPointMap = await fetchHeatForUsers(userIds, params);
        logger('Returning user point map: ', JSON.stringify(userPointMap));
        return { statusCode: 200, userPointMap };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
};
