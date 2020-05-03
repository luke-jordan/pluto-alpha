'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');
const camelcase = require('camelcase');
const opsUtil = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    retryStrategy: () => `dont retry`,
    keyPrefix: `${config.get('cache.keyPrefixes.savingsHeat')}::`
});


const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const invokeSavingsHeatLambda = async (accountIds) => {
    const includeLastActivityOfType = config.get('share.userActivities');
    const savingsHeatLambdaInvoke = invokeLambda(config.get('lambdas.calcSavingsHeat'), { accountIds, includeLastActivityOfType });
    logger('Invoke savings heat lambda with arguments: ', savingsHeatLambdaInvoke);
    const savingsHeatResult = await lambda.invoke(savingsHeatLambdaInvoke).promise();
    logger('Result of savings heat calculation: ', savingsHeatResult);
    return extractLambdaBody(savingsHeatResult).details;
};

const fetchSavingsHeatFromCache = async (accountIds) => {
    const cachedSavingsHeatForAccounts = await redis.mget(...accountIds);
    logger('Got cached savings heat for accounts:', cachedSavingsHeatForAccounts);
    return cachedSavingsHeatForAccounts.filter((result) => result !== null).map((result) => JSON.parse(result));
};

const transformProfile = (profile, friendships, userAccountMap, accountsAndSavingsHeatMap) => {
    const profileAccountId = userAccountMap[profile.systemWideUserId];
    const profileSavingsHeat = accountsAndSavingsHeatMap[profileAccountId];
    logger('Got savings heat for profile:', profileSavingsHeat);

    const targetFriendship = friendships.filter((friendship) => friendship.initiatedUserId === profile.systemWideUserId ||
        friendship.acceptedUserId === profile.systemWideUserId);

    logger('Got target friendship:', targetFriendship);

    const allowedShareItems = config.get('share.permissions');
    const userActivities = config.get('share.userActivities');

    allowedShareItems.forEach((allowedShareItem) => {
        if (!targetFriendship[0].shareItems.includes(allowedShareItem)) {
            userActivities.forEach((activity) => {
                if (profileSavingsHeat[activity]) {
                    Reflect.deleteProperty(profileSavingsHeat[activity], camelcase(allowedShareItem));
                }
            });
        }
    });
    
    profile.savingsHeat = profileSavingsHeat;
    return profile;
};

/**
 * This function appends a savings heat score to each profile. The savings heat is either fetched from cache or
 * calculated by the savings heat lambda.
 * @param {Array} profiles An array of user profiles.
 * @param {Object} userAccountMap An object mapping user system ids to thier account ids. Keys are user ids, values are account ids.
 */
const appendSavingsHeatToProfiles = async (profiles, friendships, userAccountMap) => {
    const accountIds = Object.values(userAccountMap);
    
    const cachedSavingsHeatForAccounts = await fetchSavingsHeatFromCache(accountIds);
    logger('Found cached savings heat:', cachedSavingsHeatForAccounts);

    const cachedAccounts = cachedSavingsHeatForAccounts.map((savingsHeat) => savingsHeat.accountId);
    const uncachedAccounts = accountIds.filter((accountId) => !cachedAccounts.includes(accountId));

    logger('Found uncached accounts:', uncachedAccounts);
    logger('Got cached accounts:', cachedAccounts);

    let savingsHeatFromLambda = [];
    if (uncachedAccounts.length > 0) {
        savingsHeatFromLambda = await invokeSavingsHeatLambda(uncachedAccounts);
    }

    logger('Got savings heat from lambda:', savingsHeatFromLambda);

    const savingsHeatForAccounts = [...savingsHeatFromLambda, ...cachedSavingsHeatForAccounts];
    logger('Aggregated savings heat from cache and lambda:', savingsHeatForAccounts);

    const accountsAndSavingsHeatMap = savingsHeatForAccounts.reduce((obj, savingsHeat) => ({ ...obj, [savingsHeat.accountId]: savingsHeat }), {});

    const profilesWithSavingsHeat = profiles.map((profile) => transformProfile(profile, friendships, userAccountMap, accountsAndSavingsHeatMap));

    logger('Got profiles with savings heat:', profilesWithSavingsHeat);

    return profilesWithSavingsHeat;
};

/**
 * This functions accepts a users system id and returns the user's friends.
 * @param {Object} event
 * @property {String} systemWideUserId Required. The system id of the user whose friends are to be extracted.
 */
module.exports.obtainFriends = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        
        let systemWideUserId = '';
        if (userDetails.role === 'SYSTEM_ADMIN') {
            const params = opsUtil.extractParamsFromEvent(event);
            systemWideUserId = params.systemWideUserId ? params.systemWideUserId : userDetails.systemWideUserId;
        } else {
            systemWideUserId = userDetails.systemWideUserId;
        }

        const activeFriendships = await persistenceRead.fetchActiveSavingFriendsForUser(systemWideUserId);
        logger('Got active friends for user:', activeFriendships);

        if (activeFriendships.length === 0) {
            return opsUtil.wrapResponse(activeFriendships);
        }

        const friendUserIds = activeFriendships.reduce((friendIdArray, friendship) => {
            const friendId = friendship.initiatedUserId === systemWideUserId 
                ? friendship.acceptedUserId 
                : friendship.initiatedUserId;

            return [...friendIdArray, friendId];
        }, []);

        logger('Got user ids:', friendUserIds);
    
        const profileRequests = friendUserIds.map((userIds) => persistenceRead.fetchUserProfile({ systemWideUserId: userIds }));
        const friendProfiles = await Promise.all(profileRequests);
        logger('Got friend profiles:', friendProfiles);

        const userAccountArray = await Promise.all(friendUserIds.map((userId) => persistenceRead.fetchAccountIdForUser(userId)));
        logger('Got user accounts from persistence:', userAccountArray);
        const userAccountMap = userAccountArray.reduce((obj, userAccountObj) => ({ ...obj, ...userAccountObj }));

        const profilesWithSavingsHeat = await appendSavingsHeatToProfiles(friendProfiles, activeFriendships, userAccountMap);
        
        return opsUtil.wrapResponse(profilesWithSavingsHeat);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }

};

const appendUserNameToRequest = async (friendRequest) => {
    const systemWideUserId = friendRequest.initiatedUserId;
    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId });
    friendRequest.initiatedUserName = userProfile.calledName
        ? userProfile.calledName
        : userProfile.firstName;

    return friendRequest;
};

/**
 * This function returns an array of friend requests a user has not yet accepted (or ignored). Friend requests are
 * extracted for the system id in the request context.
 */
module.exports.findFriendRequestsForUser = async (event) => {
    try {    
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const params = opsUtil.extractParamsFromEvent(event);
        const userDetails = opsUtil.extractUserDetails(event);
        
        const systemWideUserId = userDetails ? userDetails.systemWideUserId : params.systemWideUserId;

        // get friend requests
        const friendRequestsForUser = await persistenceRead.fetchFriendRequestsForUser(systemWideUserId);
        logger('Got requests:', friendRequestsForUser);
        if (friendRequestsForUser.length === 0) {
            return opsUtil.wrapResponse(friendRequestsForUser); 
        }

        // for each request append the user name of the initiating user
        const appendUserNames = friendRequestsForUser.map((request) => appendUserNameToRequest(request));
        const transformedRequests = await Promise.all(appendUserNames);
        logger('Transformed requests:', transformedRequests);

        return opsUtil.wrapResponse(transformedRequests);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};
