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

// /////////////////////////// SOME UTILITY METHODS //////////////////////////////////////////////////

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

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////////// WRITE OPERATIONS ////////////////////////////////////////////////////
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
    const uniqueClientFloats = [...new Set(userProfiles.map(extractClientFloatString))].
        map((jointPair) => ({ clientId: jointPair.split('::')[0], floatId: jointPair.split('::')[1] }));
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
};

// since this batch processes, and we _do not_ (at present) want a single failure to cause batch failure
const safeUpdateCall = async (updateCall) => {
    try {
        await rds.updateUserState(updateCall);
    } catch (err) {
        logger('FATAL_ERROR: ', err); // so that alarm is triggered for debugging
    }
};

// utility method for what comes next (events for going up/down levels)
const findLevel = (userId, levelId, listOfLevels) => (listOfLevels[userId] ? listOfLevels[userId].find((level) => level.levelId === levelId) : null);

const assembleLevelEvent = (userId, priorLevelId, newLevelId, listOfLevels) => {
    logger('Assembling level up or down event, userId: ', userId, ' prior level ID: ', priorLevelId, ' and new: ', newLevelId, ' with list: ', listOfLevels);
    const priorLevel = findLevel(userId, priorLevelId, listOfLevels);
    const newLevel = findLevel(userId, newLevelId, listOfLevels);
    if (!priorLevel && !newLevel) {
        // throw Error('User entered changed level but has null old and new level');
        logger('Error, prior and new level are null, throw error in future');
        return null;
    }

    const levelUp = !priorLevel || priorLevel.minimumPoints < newLevel.minimumPoints;
    const eventType = levelUp ? 'HEAT_LEVEL_UP' : 'HEAT_LEVEL_DOWN';

    const eventContext = { priorLevel, newLevel };
    return publisher.publishUserEvent(userId, eventType, { context: eventContext });
};

const publishLevelChanges = async (updateCalls, priorUserLevels, listOfLevels) => {
    const newLevelMap = updateCalls.reduce((obj, updateCall) => ({ ...obj, [updateCall.systemWideUserId]: updateCall.currentLevelId }), {});
    const newLevelUsers = Object.keys(newLevelMap).filter((userId) => newLevelMap[userId] !== priorUserLevels[userId]);
    if (newLevelUsers.length === 0) {
        logger('No users changed level, exit');
    }

    const publishPromises = newLevelUsers.map((userId) => assembleLevelEvent(userId, priorUserLevels[userId], newLevelMap[userId], listOfLevels));
    await Promise.all(publishPromises);    
};

// candidate for future optimization but is always going to be heavy (and hence doing it on background job and making easily available)
const updateUserStates = async (userIds) => {
    const refMomentLastPeriod = moment().subtract(1, 'month');
    const refMomentThisPeriod = moment();

    const [priorPeriodPoints, currentPeriodPoints, priorUserLevels, listOfLevels] = await Promise.all([
        rds.sumPointsForUsers(userIds, refMomentLastPeriod.startOf('month'), refMomentLastPeriod.endOf('month')),
        rds.sumPointsForUsers(userIds, refMomentThisPeriod.startOf('month')), // i.e., up until now
        rds.obtainUserLevels(userIds),
        obtainHeatLevels(userIds)
    ]);

    const updateCalls = userIds.map((userId) => assembleUpdateStateCall(userId, priorPeriodPoints, currentPeriodPoints, listOfLevels));
    logger('Assembled update calls: ', updateCalls);

    const updateResults = await Promise.all(updateCalls.map(safeUpdateCall));
    logger('Results of update calls: ', updateResults);

    await publishLevelChanges(updateCalls, priorUserLevels, listOfLevels);
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
            const userIdsToUpdateState = [...new Set(pointLogInsertions.map(({ userId }) => userId))];
            await Promise.all([...pointLogInsertions.map(publishLogForPoints), updateUserStates(userIdsToUpdateState)]);
            return { statusCode: 200, pointEventsTrigged: pointLogInsertions.length };
        }

        throw Error('Uncaught error in SQS batch processing');
    } catch (err) {
        logger('FATAL_ERROR: ', err); // so we catch this
        return { statusCode: 500, error: JSON.stringify(err) };
    }
};

const bulkCacheUsers = async (userIds) => {
    const usersInCacheRaw = await redis.mget((userIds).map((userId) => `${profileKeyPrefix}::${userId}`));
    const userIdsInCache = usersInCacheRaw.filter((profile) => profile !== null).map(JSON.parse).map(({ systemWideUserId }) => systemWideUserId);
    const userIdsToCache = userIds.filter((userId) => !userIdsInCache.includes(userId));
    await Promise.all((userIdsToCache).map((userId) => cacheUserProfile(userId)));
};

// used to flip 'current period points' to 'prior period points' at the beginning of the month
// and to set the heat level accordingly; note : could in theory make this more efficient by doing
// a simple sql query to set prior_period_points = current_period_points, current_period_points = 0,
// _but_ that would introduce a lot of fragility (if the job runs in the wrong month by accident, etc)
// so instead we have this -- as a heavy job once a month, not user blocking, not crucial, and only
// really heavy at very very large user numbers (i.e., similar to float accrual, just less frequent)
module.exports.calculateHeatStateForAllUsers = async (event) => {
    try {
        logger('Scheduled job to flip over periods, event: ', event);
        const usersWithState = await rds.obtainAllUsersWithState();
        if (usersWithState.length === 0) {
            logger('No users with state yet, exit');
            return { statusCode: 200, usersUpdated: 0 };
        }
        
        logger('Will be updating ', usersWithState.length, ' users in total');
        await bulkCacheUsers(usersWithState); // since next step assumes this
        await updateUserStates(usersWithState); // hence sequential
        logger('Completed updating user states');
        return { statusCode: 200, usersUpdated: usersWithState.length };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, error: JSON.stringify(err.message) };
    }
};

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////////// READ OPERATIONS /////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////////////

// simpler form of above (in time refactor above to just this) - commented for now but will use in obtain history
// const fetchProfile = async (userId) => {
//     const cachedProfile = await redis.get(`${profileKeyPrefix}::${userId}`);
//     if (cachedProfile) {
//         return JSON.parse(cachedProfile);
//     }

//     const fetchedProfile = await obtainProfile(userId);
//     await redis.set(`${profileKeyPrefix}::${userId}`, JSON.stringify(fetchedProfile), 'EX', config.get('cache.ttls.profile'));
//     return fetchedProfile;
// };

const fetchHeatForUsers = async (params) => {
    const { userIds, includeLastActivityOfType } = params;
    const [userHeatLevels, latestActivities] = await Promise.all([
        rds.obtainUserLevels(userIds, true), rds.obtainLatestActivities(userIds, includeLastActivityOfType)
    ]);

    const userHeatMap = userIds.reduce((obj, userId) => ({
        ...obj, [userId]: { currentLevel: userHeatLevels[userId], recentActivity: latestActivities[userId] }
    }), {});

    return userHeatMap;
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
            logger('Fetching user heat for: ', systemWideUserId);
            const userLevel = await rds.fetchUserLevel(systemWideUserId);
            logger('From persistence: ', userLevel);
            return { statusCode: 200, body: JSON.stringify({ currentLevel: userLevel }) };
        }

        const { userIds } = params;
        const userHeatMap = await fetchHeatForUsers(userIds, params);
        
        // note: if return the promise directly, lambda runtime does not wrap properly, so errors propagate incorrectly
        logger('Returning user point map: ', JSON.stringify(userHeatMap));
        return { statusCode: 200, userHeatMap };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
};
