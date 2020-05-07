'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');

const camelCaseKeys = require('camelcase-keys');

const dynamoCommon = require('dynamo-common');
const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    retryStrategy: () => `dont retry`
});

const PROFILE_CACHE_TTL_IN_SECONDS = config.get('cache.ttls.profile');
const USER_ID_CACHE_TTL_IN_SECONDS = config.get('cache.ttls.userId');

const relevantProfileColumns = [
    'system_wide_user_id',
    'personal_name',
    'family_name',
    'called_name',
    'emai_adress',
    'phone_number',
    'referral_code',
    'country_code'
];

const fetchUserProfileFromDB = async (systemWideUserId) => {
    logger(`Fetching profile for user id: ${systemWideUserId} from table: ${config.get('tables.profileTable')}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.profileTable'), { systemWideUserId }, relevantProfileColumns);
    // logger('Result from DynamoDB: ', rowFromDynamo);

    if (!rowFromDynamo) {
        throw new Error(`Error! No profile found for: ${systemWideUserId}`);
    }

    return rowFromDynamo;
};

const fetchUserIdForAccountFromDB = async (accountId) => {
    const accountTable = config.get('tables.accountTable');
    const query = `select owner_user_id from ${accountTable} where account_id = $1`;
    const fetchResult = await rdsConnection.selectQuery(query, [accountId]);
    return fetchResult.length > 0 ? fetchResult[0]['owner_user_id'] : null;
};

const obtainFromDbAndCache = async (systemWideUserId) => {
    const userProfile = await fetchUserProfileFromDB(systemWideUserId);
    await redis.set(systemWideUserId, JSON.stringify(userProfile), 'EX', PROFILE_CACHE_TTL_IN_SECONDS);
    logger(`Successfully fetched 'user profile' from database and stored in cache`);
    return userProfile;
}

const fetchUserProfileFromCacheOrDB = async (systemWideUserId) => {
    logger(`Fetching 'user profile' from database or cache`);

    const key = `${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`;
    try {
        const responseFromCache = await redis.get(key);
        if (!responseFromCache) {
            return obtainFromDbAndCache(systemWideUserId);
        }
        logger(`Successfully fetched 'user profile' from cache`);
        return JSON.parse(responseFromCache);    
    } catch (err) {
        logger('Error in cache: ', err);
        return obtainFromDbAndCache(systemWideUserId);
    }
        
};

const fetchUserIdForAccountFromCacheOrDB = async (accountId) => {
    logger(`Fetching 'user id' from database or cache`);

    const key = `${config.get('cache.keyPrefixes.userId')}::${accountId}`;
    const responseFromCache = await redis.get(key);

    if (!responseFromCache) {
        const systemWideUserId = await fetchUserIdForAccountFromDB(accountId);
        logger('Got account owner id', systemWideUserId);
        await redis.set(accountId, systemWideUserId, 'EX', USER_ID_CACHE_TTL_IN_SECONDS);
        logger(`Successfully fetched 'user id' from db and stored in cache`);
        return systemWideUserId;
    }
    
    logger(`Successfully fetched 'user id' from cache`);
    return responseFromCache;
};

/**
 * This function fetches a user's profile. It accepts either the users system id or an array of the users accound ids
 * @param {object} params An object either of the form { systemWideUserId: '6802ad23-e9...' } or { accountIds: ['d7387b3a-40...', '30cae50a-2e...', ...]}
 */
module.exports.fetchUserProfile = async (params) => {
    if (!params.systemWideUserId && !params.accountIds) {
        throw new Error('Error! Please provide either the users system id or account ids');
    }

    let systemWideUserId = '';
    if (!params.systemWideUserId && params.accountIds) {
        const accountIds = params.accountIds;
        const accountIdsLookUp = accountIds.map((accountId) => fetchUserIdForAccountFromCacheOrDB(accountId));
        const resultOfLookup = await Promise.all(accountIdsLookUp);
        logger('Result of user id lookup:', resultOfLookup);
        systemWideUserId = resultOfLookup[0];
    } else {
        systemWideUserId = params.systemWideUserId;
    }
    logger('Got user id:', systemWideUserId);

    return fetchUserProfileFromCacheOrDB(systemWideUserId);
};

/**
 * This function accepts a user id and returns the user ids of the users friends.
 * @param {object} systemWideUserId The user's ID
 */
module.exports.fetchActiveSavingFriendsForUser = async (systemWideUserId) => {
    const friendshipTable = config.get('tables.friendshipTable');
    
    // we are checking both sides at once here (we can optimize this in time, but it will be very quick, esp vs rest of this process)

    const acceptedQuery = `select relationship_id, accepted_user_id, share_items from ${friendshipTable} where initiated_user_id = $1 and relationship_status = $2`;
    const initiatedQuery = `select relationship_id, initiated_user_id, share_items from ${friendshipTable} where accepted_user_id = $1 and relationship_status = $2`;
    
    const [acceptedResult, initiatedResult] = await Promise.all([
        rdsConnection.selectQuery(acceptedQuery, [systemWideUserId, 'ACTIVE']),
        rdsConnection.selectQuery(initiatedQuery, [systemWideUserId, 'ACTIVE'])
    ]);

    const acceptedFriends = acceptedResult.map((row) => camelCaseKeys(row));
    const initiatedFriends = initiatedResult.map((row) => camelCaseKeys(row));

    // unique constraint on table means do not have to worry about duplicates
    const fetchedActiveFriends = [...acceptedFriends, ...initiatedFriends];

    logger('Retrieved active friendships for user:', fetchedActiveFriends);
    
    return { [systemWideUserId]: fetchedActiveFriends };
};

/**
 * This function fetches a friendship request by its request id.
 * @param {String} requestId The friendships request id.
 */
module.exports.fetchFriendshipRequestById = async (requestId) => {
    const friendReqTable = config.get('tables.friendRequestTable');
    const selectQuery = `select initiated_user_id, target_user_id from ${friendReqTable} where request_id = $1`;
    const fetchResult = await rdsConnection.selectQuery(selectQuery, [requestId]);
    logger('Fetched friend request:', fetchResult);

    return fetchResult.length > 0 ? camelCaseKeys(fetchResult[0]) : null;
};

/**
 * This function fetches a friendship request by its request code.
 * @param {String} requestCode The friendships request code.
 */
module.exports.fetchFriendshipRequestByCode = async (requestCode) => {
    const friendReqTable = config.get('tables.friendRequestTable');
    const selectQuery = `select initiated_user_id, target_user_id from ${friendReqTable} where request_code = $1`;
    const fetchResult = await rdsConnection.selectQuery(selectQuery, [requestCode]);
    logger('Fetched friend request:', fetchResult);

    return fetchResult.length > 0 ? camelCaseKeys(fetchResult[0]) : null;
};

/**
 * This functions returns an array of active requests codes.
 */
module.exports.fetchActiveRequestCodes = async () => {
    const friendReqTable = config.get('tables.friendRequestTable');
    const selectQuery = `select request_code from ${friendReqTable} where request_status = $1`;
    const fetchResult = await rdsConnection.selectQuery(selectQuery, ['PENDING']);
    logger('Found active friend requests:', fetchResult);

    return Array.isArray(fetchResult) && fetchResult.length > 0 
        ? fetchResult.map((result) => result['request_code']) : [];
};

/**
 * This function fetches a users pending friend requests, i.e. requests the user has not yet accepted or ignored
 */
module.exports.fetchFriendRequestsForUser = async (systemWideUserId) => {
    const friendReqTable = config.get('tables.friendRequestTable');
    const receivedQuery = `select * from ${friendReqTable} where target_user_id = $1 and request_status = $2`;
    const initiatedQuery = `select * from ${friendReqTable} where initiated_user_id = $1 and request_status = $2`;

    const [receivedResult, initiatedResult] = await Promise.all([
        rdsConnection.selectQuery(receivedQuery, [systemWideUserId, 'PENDING']),
        rdsConnection.selectQuery(initiatedQuery, [systemWideUserId, 'PENDING'])
    ]);

    const receivedRequests = receivedResult.map((row) => camelCaseKeys(row));
    const initiatedRequests = initiatedResult.map((row) => camelCaseKeys(row));

    const friendRequests = [...receivedRequests, ...initiatedRequests];

    // logger('Found pending requests for user:', friendRequests);

    return friendRequests;
};

/**
 * Fetches account id associated with an system id. To be adapted to return all user accounts.
 */
module.exports.fetchAccountIdForUser = async (systemWideUserId) => {
    const accountTable = config.get('tables.accountTable');
    const selectQuery = `select account_id from ${accountTable} where owner_user_id = $1`;
    const fetchResult = await rdsConnection.selectQuery(selectQuery, [systemWideUserId]);
    return fetchResult.length > 0
        ? { [systemWideUserId]: fetchResult[0]['account_id'] }
        : { };
};

/**
 * Counts the number of mutual friends between a user and an array of other users.
 */
module.exports.countMutualFriends = async (targetUserId, initiatedUserIds) => {
    const friendshipsForTargetUser = await exports.fetchActiveSavingFriendsForUser(targetUserId);
    const friendIdsForTargetUser = friendshipsForTargetUser[targetUserId].map((friend) => friend.initiatedUserId || friend.acceptedUserId);
    logger('Found friends for target user:', friendIdsForTargetUser);

    const friendsForInitiatedUsers = await Promise.all(initiatedUserIds.map((userId) => exports.fetchActiveSavingFriendsForUser(userId)));
    logger('Found friends for initaited users:', friendsForInitiatedUsers);

    const mutualFriendCounts = friendsForInitiatedUsers.map((friendships) => {
        const initiatedUserId = Object.keys(friendships)[0];
        const friendIdsForInitiatedUser = friendships[initiatedUserId].map((friendship) => friendship.initiatedUserId || friendship.acceptedUserId);
        logger('Found friends for initiator:', friendIdsForInitiatedUser);
        const mutualFriends = friendIdsForTargetUser.filter((friendId) => friendIdsForInitiatedUser.includes(friendId));
        logger('Found mutual friends:', mutualFriends);

        return { [initiatedUserId]: mutualFriends.length };
    });

    return mutualFriendCounts;
};
