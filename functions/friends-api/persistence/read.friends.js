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
    'phone_number'
];

const fetchUserProfileFromDB = async (systemWideUserId) => {
    logger(`Fetching profile for user id: ${systemWideUserId} from table: ${config.get('tables.profileTable')}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.profileTable'), { systemWideUserId }, relevantProfileColumns);
    logger('Result from DynamoDB: ', rowFromDynamo);

    if (!rowFromDynamo) {
        throw new Error(`Error! No profile found for: ${systemWideUserId}`);
    }

    return rowFromDynamo;
};

const fetchUserIdForAccountFromDB = async (accountId) => {
    const accountTable = config.get('tables.accountTable');
    const query = `select owner_user_id from ${accountTable} where account_id = $1`;
    const fetchResult = await rdsConnection.selectQuery(query, [accountId]);
    return fetchResult[0]['owner_user_id'];
};

const fetchAcceptedUserIdsForUser = async (systemWideUserId) => {
    const friendTable = config.get('tables.friendTable');
    const query = `select accepted_user_id from ${friendTable} where initiated_user_id = $1`;
    const fetchedUserIds = await rdsConnection.selectQuery(query, [systemWideUserId]);
    
    return fetchedUserIds.map((userId) => userId['accepted_user_id']);
};

const fetchUserProfileFromCacheOrDB = async (systemWideUserId) => {
    logger(`Fetching 'user profile' from database or cache`);

    const key = `${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`;
    const responseFromCache = await redis.get(key);
    
    if (!responseFromCache) {
        logger(`Profile for '${systemWideUserId}' NOT found in cache. Searching DB`);
        const userProfile = await fetchUserProfileFromDB(systemWideUserId);
        await redis.set(systemWideUserId, JSON.stringify(userProfile), 'EX', PROFILE_CACHE_TTL_IN_SECONDS);
        logger(`Successfully fetched 'user profile' from database and stored in cache`);

        return userProfile;
    }
    
    logger(`Successfully fetched 'user profile' from cache`);
    return JSON.parse(responseFromCache);
};

const fetchUserIdForAccountFromCacheOrDB = async (accountId) => {
    logger(`Fetching 'user id' from database or cache`);

    const key = `${config.get('cache.keyPrefixes.userId')}::${accountId}`;
    const responseFromCache = await redis.get(key);

    if (!responseFromCache) {
        logger('Account user id not found in cache. Searching DB');
        const systemWideUserId = await fetchUserIdForAccountFromDB(accountId);
        await redis.set(accountId, systemWideUserId, 'EX', USER_ID_CACHE_TTL_IN_SECONDS);
        logger('Successfully stored user id in cache');

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
 * @param {object} params An object of the form { systemWideUserId: 'e9a83c01-9d...' }
 */
module.exports.getFriendIdsForUser = async (params) => {
    if (!params.systemWideUserId) {
        throw new Error('Error! Missing user identifier');
    }

    const systemWideUserId = params.systemWideUserId;
    return fetchAcceptedUserIdsForUser(systemWideUserId);
};

/**
 * This function fetches a friendship request by its request id.
 * @param {string} requestId The friendships request id.
 */
module.exports.fetchFriendshipRequest = async (requestId) => {
    const friendRequestTable = config.get('tables.friendRequestTable');
    const selectQuery = `select initiated_user_id, target_user_id from ${friendRequestTable} where request_id = $1`;

    const fetchResult = await rdsConnection.selectQuery(selectQuery, [requestId]);
    logger('Fetched friend request:', fetchResult);

    return fetchResult.length > 0 ? camelCaseKeys(fetchResult[0]) : null;
};

/**
 * This function searches the user id associated with a contact detail.
 * @param {string} contactDetail Either the phone number or email address of the user whose system id is sought.
 */
module.exports.fetchUserByContactDetail = async (contactDetail) => {
    logger('Searching for user with contact detail', contactDetail);
    const phoneQuery = dynamoCommon.fetchSingleRow(config.get('tables.phoneTable'), { phoneNumber: contactDetail });
    const emailQuery = dynamoCommon.fetchSingleRow(config.get('tables.emailTable'), { emailAddress: contactDetail });

    const resultFromDynamo = await Promise.all([phoneQuery, emailQuery]);
    logger('Dynamo search for user by contact resulted in:', resultFromDynamo);

    const itemFromDynamo = resultFromDynamo.filter((result) => typeof result === 'object' && Object.keys(result).length > 0);
    return itemFromDynamo.length > 0 ? camelCaseKeys(itemFromDynamo[0]) : null;
};
