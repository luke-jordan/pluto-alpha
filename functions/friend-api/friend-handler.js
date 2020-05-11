'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');

const opsUtil = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    retryStrategy: () => `dont retry`,
    keyPrefix: `${config.get('cache.keyPrefixes.savingHeat')}::`
});

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const invokeSavingHeatLambda = async (accountIds) => {
    const includeLastActivityOfType = config.get('share.activities');
    const savingHeatLambdaInvoke = invokeLambda(config.get('lambdas.calcSavingHeat'), { accountIds, includeLastActivityOfType });
    logger('Invoke savings heat lambda with arguments: ', savingHeatLambdaInvoke);
    const savingHeatResult = await lambda.invoke(savingHeatLambdaInvoke).promise();
    logger('Result of savings heat calculation: ', savingHeatResult);
    const heatPayload = JSON.parse(savingHeatResult.Payload);
    const { details } = heatPayload;
    return details;
};

const fetchSavingHeatFromCache = async (accountIds) => {
    const cachedSavingHeatForAccounts = await redis.mget(...accountIds);
    logger('Got cached savings heat for accounts:', cachedSavingHeatForAccounts);
    return cachedSavingHeatForAccounts.filter((result) => result !== null).map((result) => JSON.parse(result));
};

const stripDownToPermitted = (shareItems, transaction) => {
    logger('Stripping down, share items: ', shareItems, ' and transaction: ', transaction);
    if (!shareItems || shareItems.length === 0 || !shareItems.includes('LAST_ACTIVITY')) {
        logger('No share items, exit');
        return null;
    }

    const strippedActivity = {
        creationTime: transaction.creationTime,
        settlementTime: transaction.settlementTime 
    };

    if (shareItems && shareItems.includes('LAST_AMOUNT')) {
        strippedActivity.amount = transaction.amount;
        strippedActivity.unit = transaction.unit;
        strippedActivity.balance = transaction.balance;
    }

    return strippedActivity;
};

const transformProfile = async (profile, friendshipDetails, accountMaps) => {
    const { userAccountMap, accountAndSavingHeatMap } = accountMaps;
    const { friendships, mutualFriendCounts } = friendshipDetails;
    // logger('Map thing: ', userAccountMap);
    const profileAccountId = userAccountMap[profile.systemWideUserId];
    // logger('Profile account ID: ', profileAccountId);
    logger('And from saving heat: ', accountAndSavingHeatMap[profileAccountId]);
    const { savingHeat, recentActivity } = accountAndSavingHeatMap[profileAccountId];
        
    const targetFriendship = friendships.filter((friendship) => friendship.initiatedUserId === profile.systemWideUserId ||
        friendship.acceptedUserId === profile.systemWideUserId)[0];

    logger('Got target friendship:', targetFriendship);

    const expectedActivities = config.get('share.activities');
    logger('Recent activity: ', recentActivity);
    const extractShareableDetails = (activity) => stripDownToPermitted(targetFriendship.shareItems, recentActivity[activity]);
    
    const lastActivity = expectedActivities.reduce((obj, activity) => ({ ...obj, [activity]: extractShareableDetails(activity) }), {});

    const mutualFriendCount = mutualFriendCounts.filter((count) => typeof count[profile.systemWideUserId] === 'number');
    const numberOfMutualFriends = mutualFriendCount[0][profile.systemWideUserId];
    logger('Mutual friends:', numberOfMutualFriends);

    const transformedProfile = {
        relationshipId: targetFriendship.relationshipId,
        personalName: profile.personalName,
        familyName: profile.familyName,
        calledName: profile.calledName ? profile.calledName : profile.personalName,
        contactMethod: profile.phoneNumber || profile.emailAddress,
        shareItems: targetFriendship.shareItems,
        savingHeat,
        lastActivity,
        numberOfMutualFriends
    };
    
    return transformedProfile;
};

/**
 * This function appends a savings heat score to each profile. The savings heat is either fetched from cache or
 * calculated by the savings heat lambda.
 * @param {Array} profiles An array of user profiles.
 * @param {Object} userAccountMap An object mapping user system ids to thier account ids. Keys are user ids, values are account ids.
 */
const appendSavingHeatToProfiles = async (profiles, userAccountMap, friendshipDetails) => {
    const accountIds = Object.values(userAccountMap);
    
    const cachedSavingHeatForAccounts = await fetchSavingHeatFromCache(accountIds);
    // logger('Found cached savings heat:', cachedSavingHeatForAccounts);

    const cachedAccounts = cachedSavingHeatForAccounts.map((savingHeat) => savingHeat.accountId);
    const uncachedAccounts = accountIds.filter((accountId) => !cachedAccounts.includes(accountId));

    // logger('Found uncached accounts:', uncachedAccounts);
    logger('Got cached accounts:', cachedAccounts);

    let savingHeatFromLambda = [];
    if (uncachedAccounts.length > 0) {
        savingHeatFromLambda = await invokeSavingHeatLambda(uncachedAccounts);
    }

    logger('Got savings heat from lambda:', savingHeatFromLambda);

    const savingHeatForAccounts = [...savingHeatFromLambda, ...cachedSavingHeatForAccounts];
    logger('Aggregated savings heat from cache and lambda:', savingHeatForAccounts);

    const accountAndSavingHeatMap = savingHeatForAccounts.reduce((obj, savingHeat) => ({ ...obj, [savingHeat.accountId]: savingHeat }), {});
    logger('Map: ', accountAndSavingHeatMap);

    const accountMaps = { userAccountMap, accountAndSavingHeatMap };

    const profilesWithSavingHeat = await Promise.all(
        profiles.map((profile) => transformProfile(profile, friendshipDetails, accountMaps))
    );

    logger('Got profiles with savings heat:', profilesWithSavingHeat);

    return profilesWithSavingHeat;
};

/**
 * The function fetches the user profile and saving heat for the calling user. It differs from the
 * appendSavingHeatToProfiles process in that it does not seek friendships
 * @param {string} systemWideUserId 
 */
const fetchOwnSavingHeat = async (systemWideUserId) => {
    const userAccountMap = await persistenceRead.fetchAccountIdForUser(systemWideUserId);
    const accountId = userAccountMap[systemWideUserId];
    logger(`Got account id: ${accountId}`);

    let savingHeat = null;

    const savingHeatFromCache = await fetchSavingHeatFromCache([accountId]);
    logger('Got caller saving heat from cache:', savingHeatFromCache);

    if (savingHeatFromCache.length === 0) {
        const savingHeatFromLambda = await invokeSavingHeatLambda([accountId]);
        logger('Got caller saving heat from lambda:', savingHeatFromLambda);
        savingHeat = savingHeatFromLambda[0].savingHeat;
    } else {
        savingHeat = savingHeatFromCache[0].savingHeat;
    }

    logger('Got saving heat:', savingHeat);

    return { relationshipId: 'SELF', savingHeat };
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
    
        const userFriendshipMap = await persistenceRead.fetchActiveSavingFriendsForUser(systemWideUserId);
        logger('Got user friendship map:', userFriendshipMap);
        
        const friendships = userFriendshipMap[systemWideUserId];
        logger('Got user friendships:', friendships);
        if (!friendships || friendships.length === 0) {
            return opsUtil.wrapResponse([]);
        }

        const friendUserIds = friendships.map((friendship) => friendship.initiatedUserId || friendship.acceptedUserId);
        logger('Got user ids:', friendUserIds);

        const mutualFriendCounts = await persistenceRead.countMutualFriends(systemWideUserId, friendUserIds);
        logger('Got mutual friend counts:', mutualFriendCounts);

        const friendshipDetails = { friendships, mutualFriendCounts };
    
        const profileRequests = friendUserIds.map((userId) => persistenceRead.fetchUserProfile({ systemWideUserId: userId }));
        const friendProfiles = await Promise.all(profileRequests);
        logger('Got friend profiles:', friendProfiles);

        const userAccountArray = await Promise.all(friendUserIds.map((userId) => persistenceRead.fetchAccountIdForUser(userId)));
        logger('Got user accounts from persistence:', userAccountArray);
        const userAccountMap = userAccountArray.reduce((obj, userAccountObj) => ({ ...obj, ...userAccountObj }), {});

        const profilesWithSavingHeat = await appendSavingHeatToProfiles(friendProfiles, userAccountMap, friendshipDetails);

        // todo: reuse above infra for user
        const savingHeatForCallingUser = await fetchOwnSavingHeat(systemWideUserId);
        profilesWithSavingHeat.push(savingHeatForCallingUser);
        
        return opsUtil.wrapResponse(profilesWithSavingHeat);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }

};

/**
 * This functions deactivates a friendship.
 * @param {Object} event
 * @property {String} relationshipId The id of the relationship to be deactivated.
 */
module.exports.deactivateFriendship = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { relationshipId } = opsUtil.extractParamsFromEvent(event);
        if (!relationshipId) {
            throw new Error('Error! Missing relationshipId');
        }

        const deactivationResult = await persistenceWrite.deactivateFriendship(relationshipId);
        logger('Result of friendship deactivation:', deactivationResult);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { deactivationResult } });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};
