'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');

const opsUtil = require('ops-util-common');
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
    'country_code',
    'user_status'
];

const safeRedisGet = async (key) => {
    // ioredis has a nasty habit of throwing an error instead of reconnecting (to find a fix)
    let responseFromCache = null;
    try {
        responseFromCache = await redis.get(key);
    } catch (err) {
        logger('REDIS_ERROR: ', err);
    }
    return responseFromCache;
};

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
    const profileKey = `${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`;
    await redis.set(profileKey, JSON.stringify(userProfile), 'EX', PROFILE_CACHE_TTL_IN_SECONDS);
    logger(`Successfully fetched 'user profile' from database and stored in cache`);
    return userProfile;
};

const fetchUserProfileFromCacheOrDB = async (systemWideUserId, forceCacheReset = false) => {
    logger(`Fetching 'user profile' from database or cache`);

    const key = `${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`;
    const responseFromCache = await (!forceCacheReset && safeRedisGet(key));
    if (!responseFromCache) {
        return obtainFromDbAndCache(systemWideUserId);
    }
    logger(`Successfully fetched 'user profile' from cache`);
    return JSON.parse(responseFromCache);            
};

const fetchUserIdForAccountFromCacheOrDB = async (accountId) => {
    logger(`Fetching 'user id' from database or cache`);

    const key = `${config.get('cache.keyPrefixes.userId')}::${accountId}`;
    const responseFromCache = await safeRedisGet(key);
   
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
 * Utility method to get account IDs from cache
 */
module.exports.fetchSavingHeatFromCache = async (accountIds) => {
    try {
        const accountIdsWithKey = accountIds.map((accountId) => `$${config.get('cache.keyPrefixes.savingHeat')}::${accountId}`);
        const cachedSavingHeatForAccounts = await redis.mget(...accountIdsWithKey);
        logger('Got cached savings heat for accounts:', cachedSavingHeatForAccounts);
        return cachedSavingHeatForAccounts.filter((result) => result !== null).map((result) => JSON.parse(result));
    } catch (err) {
        logger('FATAL_ERROR: Redis connection closed', err);
        return [];
    }
};

/**
 * This function fetches a user's profile. It accepts either the users system id or an array of the users accound ids
 * @param {object} params An object with either a user ID or a set of account IDs
 * @property {string} systemWideUserId userId
 * @property {array} accountIds List of account Ids
 * @property {boolean} forceCacheReset Force cache reset on profile (e.g., if real-time sensitive operation). Optional.
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

    const forceCacheReset = params.forceCacheReset || false;
    return fetchUserProfileFromCacheOrDB(systemWideUserId, forceCacheReset);
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
 * This looks for a friendship request initiated by a user, with one or other of a contact method
 * @param {String} initiatedUserId Sought for user who might have initiated
 * @param {String} contactMethod Sought for contact method
 */
module.exports.findPossibleFriendRequest = async (initiatedUserId, contactMethod) => {
    const selectQuery = `select request_id from ${config.get('tables.friendRequestTable')} where initiated_user_id = $1 ` +
        `and target_contact_details ->> 'contactMethod' = $2 order by creation_time desc limit 1`; // limit is just in case
    logger('Seeking with query: ', selectQuery);
    const findResult = await rdsConnection.selectQuery(selectQuery, [initiatedUserId, contactMethod]);
    logger('Found: ', findResult);
    return findResult.length > 0 ? camelCaseKeys(findResult[0]) : null;
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
        // logger('Found friends for initiator:', friendIdsForInitiatedUser);
        const mutualFriends = friendIdsForTargetUser.filter((friendId) => friendIdsForInitiatedUser.includes(friendId));
        // logger('Found mutual friends:', mutualFriends);

        return { [initiatedUserId]: mutualFriends.length };
    });

    return mutualFriendCounts;
};

/**
 * Looks for logs that a user should view
 */
module.exports.fetchAlertLogsForUser = async (systemWideUserId, logTypes) => {
    const selectQuery = `select * from ${config.get('tables.friendLogTable')} where is_alert_active = true and ` +
        `$1 = any(to_alert_user_id) and not($1 = any(alerted_user_id)) ` +
        `and log_type in (${opsUtil.extractArrayIndices(logTypes, 2)})`;
    
        const queryValues = [systemWideUserId, ...logTypes];
    logger('Finding alerts with query: ', selectQuery, ' and values: ', queryValues);

    const alertLogs = await rdsConnection.selectQuery(selectQuery, queryValues);
    return alertLogs.map(camelCaseKeys);
};