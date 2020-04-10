'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');

const dynamoCommon = require('dynamo-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const Redis = require('ioredis');

const PROFILE_CACHE_TTL_IN_SECONDS = config.get('cache.ttls.profile');
const USER_ID_CACHE_TTL_IN_SECONDS = config.get('cache.ttls.userId');

const relevantProfileColumns = [
    'systemWideUserId',
    'personalName',
    'familyName',
    'calledName',
    'emailAddress',
    'phoneNumber'
];

const fetchUserProfileFromDB = async (systemWideUserId) => {
    logger(`Fetching profile for user id: ${systemWideUserId} from table: ${config.get('tables.dynamoProfileTable')}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamoProfileTable'), { systemWideUserId }, relevantProfileColumns);
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

const initiateCacheConnection = async (keyPrefix) => {
    logger('Initiating connection to cache');
    try {
        const connectionToCache = new Redis({ 
            port: config.get('cache.port'), 
            host: config.get('cache.host'), 
            retryStrategy: () => `dont retry`, 
            keyPrefix
        });
        logger('Successfully initiated connection to cache');
        return connectionToCache;
    } catch (error) {
        logger(`Error while initiating connection to cache. Error: ${JSON.stringify(error.message)}`);
        return null;
    }
};

const fetchUserDetailsFromCache = async (key, keyPrefix) => {
    logger(`Fetching user detail from cache`);
    const cache = await initiateCacheConnection(keyPrefix);
    if (!cache || cache.status === 'connecting') {
        return { cache: null, responseFromCache: null };
    }

    const responseFromCache = await cache.get(key);
    return { cache, responseFromCache };
};

const fetchUserProfileFromCacheOrDB = async (systemWideUserId) => {
    logger(`Fetching 'user profile' from database or cache`);

    const keyPrefix = `${config.get('cache.keyPrefixes.profile')}::`;
    const { cache, responseFromCache } = await fetchUserDetailsFromCache(systemWideUserId, keyPrefix);
    
    if (!responseFromCache) {
        logger(`Profile for '${systemWideUserId}' NOT found in cache. Searching DB`);
        const userProfile = await fetchUserProfileFromDB(systemWideUserId);
        if (cache) {
            await cache.set(systemWideUserId, JSON.stringify(userProfile), 'EX', PROFILE_CACHE_TTL_IN_SECONDS);
            logger(`Successfully fetched 'user profile' from database and stored in cache`);
        }

        return userProfile;
    }
    
    logger(`Successfully fetched 'user profile' from cache`);
    return responseFromCache;
};

const fetchUserIdForAccountFromCacheOrDB = async (accountId) => {
    logger(`Fetching 'user id' from database or cache`);

    const keyPrefix = `${config.get('cache.keyPrefixes.userId')}::`;
    const { cache, responseFromCache } = await fetchUserDetailsFromCache(accountId, keyPrefix);

    if (!responseFromCache) {
        logger('Account user id not found in cache. Searching DB');
        const systemWideUserId = await fetchUserIdForAccountFromDB(accountId);
        if (cache) {
            await cache.set(accountId, systemWideUserId, 'EX', USER_ID_CACHE_TTL_IN_SECONDS);
            logger('Successfully stored user id in cache');
        }

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
