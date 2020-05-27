'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');
const camelCaseKeys = require('camelcase-keys');

const dynamoCommon = require('dynamo-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    
    maxRetriesPerRequest: 2,
    reconnectOnError: (err) => {
        const targetError = 'READONLY';
        // Only reconnect when the error contains "READONLY"
        if (err.message.includes(targetError)) {
        return true; // or `return 1;`
        }
    }
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

/**
 * Finds savings pools for a user
 */
module.exports.fetchSavingPoolsForUser = async (systemWideUserId) => {
    const fetchQuery = `select * from ${config.get('tables.friendPoolTable')} inner join ${config.get('tables.friendPoolJoinTable')} ` +
        `on ${config.get('tables.friendPoolTable')}.saving_pool_id = ${config.get('tables.friendPoolJoinTable')}.saving_pool_id ` +
        `where friend_data.saving_pool.active = true and friend_data.saving_pool_participant.active = true and ` + 
        `friend_data.saving_pool_participant.user_id = $1`;
    logger('Fetching pools for user with query: ', fetchQuery);

    const queryResult = await rdsConnection.selectQuery(fetchQuery, [systemWideUserId]);

    const convertTimeStamps = (camelizedPool) => ({ ...camelizedPool, creationTime: moment(camelizedPool.creationTime), updatedTime: moment(camelizedPool.creationTime) });
    return queryResult.map((row) => camelCaseKeys(row)).map((row) => convertTimeStamps(row));
};

const fetchTransactionsForPools = async (savingPoolIds) => {
    logger('Fetching transactions for pools: ', savingPoolIds);

    const rawFetchQuery = `select transaction_id, settlement_time, amount, currency, unit, owner_user_id, ` +
        `${config.get('tables.transactionTable')}.tags from ${config.get('tables.transactionTable')} ` +
        `inner join ${config.get('tables.accountTable')} ` +
        `on transaction_data.core_transaction_ledger.account_id = account_data.core_account_ledger.account_id ` +
        `where ${config.get('tables.transactionTable')}.tags && $1`;

    const tagArray = savingPoolIds.map((poolId) => `SAVING_POOL::${poolId}`);

    logger('Going to get transaction details, with this query: ', rawFetchQuery, ' and tags: ', tagArray);
    const queryResult = await rdsConnection.selectQuery(rawFetchQuery, [tagArray]);
    logger('Raw result fetching transactions for pool: ', queryResult);
    return queryResult;
};

// may want to batch select this in the future
const fetchParticipantsForPools = async (savingPoolIds) => {
    // include saving pool ID in case batching in future;
    const fetchQuery = `select user_id, relationship_id, saving_pool_id from ${config.get('tables.friendPoolJoinTable')} ` +
        `where saving_pool_id in (${opsUtil.extractArrayIndices(savingPoolIds)}) and active = true`;
    logger('Fetching participants for pools, with query: ', fetchQuery);
    const queryResult = await rdsConnection.selectQuery(fetchQuery, savingPoolIds);
    logger('Raw result fetching participants: ', queryResult);
    return queryResult;
};

/**
 * Calculates current balance of a set of pools. See tests for notes on future optimizations. What currency a zero balance displays in should be default for user in time, hence
 * passed in here rather than stored with pool (other option, but at some point may very well want multi-currency pools)
 */
module.exports.calculatePoolBalances = async (savingPoolIds, zeroCurrency = 'ZAR') => {
    const queryResult = await fetchTransactionsForPools(savingPoolIds);

    const poolAggregator = (rows, savingPoolId) => {
        const poolTransactions = rows.filter((row) => row.tags && row.tags.includes(`SAVING_POOL::${savingPoolId}`));
        if (poolTransactions.length === 0) {
            return { amount: 0, unit: 'HUNDREDTH_CENT', savingPoolId, currency: zeroCurrency };
        }
        logger('Pool transactions: ', poolTransactions);
        const currency = poolTransactions[0]['currency']; // obv only works as long as users are single-currency
        const amount = opsUtil.sumOverUnits(poolTransactions, 'HUNDREDTH_CENT', 'amount');
        return { savingPoolId, amount, unit: 'HUNDREDTH_CENT', currency };
    };

    return savingPoolIds.map((poolId) => poolAggregator(queryResult, poolId));
};

module.exports.fetchSavingPoolDetails = async (savingPoolId, includeDetails = false) => {
    // first get the basic stuff we need
    const fetchPoolQuery = `select * from ${config.get('tables.friendPoolTable')} where saving_pool_id = $1`;
    const rawResult = await rdsConnection.selectQuery(fetchPoolQuery, [savingPoolId]);
    logger('Pool from persistence: ', rawResult);
    if (!rawResult || rawResult.length === 0) {
        return null;
    }

    const savingPool = camelCaseKeys(rawResult[0]);
    savingPool.creationTime = moment(savingPool.creationTime);
    savingPool.updatedTime = moment(savingPool.updatedTime);

    if (!includeDetails) {
        logger('Not including details, returning');
        return savingPool;
    }

    // can do these in parallel
    const [transactionRows, participantRows] = await Promise.all(
        [fetchTransactionsForPools([savingPoolId]), fetchParticipantsForPools([savingPoolId])]
    );

    const participatingUsers = participantRows.map((row) => ({ userId: row['user_id'], relationshipId: row['relationship_id'] || 'CREATOR' }));
    logger('Transformed participating users: ', participatingUsers);

    const transactionRecord = transactionRows.map(camelCaseKeys).map((transaction) => ({
        ownerUserId: transaction.ownerUserId,
        settlementTime: moment(transaction.settlementTime),
        amount: transaction.amount,
        unit: transaction.unit,
        currency: transaction.currency
    }));
    logger('Transformed transaction records: ', transactionRecord);

    savingPool.currentAmount = opsUtil.sumOverUnits(transactionRows, 'HUNDREDTH_CENT', 'amount');
    savingPool.currentUnit = 'HUNDREDTH_CENT';
    savingPool.currentCurrency = savingPool.targetCurrency;

    savingPool.participatingUsers = participatingUsers;
    savingPool.transactionRecord = transactionRecord;

    logger('Assembled: ', savingPool);
    return savingPool;
};

module.exports.obtainFriendIds = async (referenceUserId, relationshipIds) => {
    const fetchQuery = `select initiated_user_id, accepted_user_id, relationship_id from ${config.get('tables.friendshipTable')} ` +
        `where relationship_status = $1 and (initiated_user_id = $2) or (accepted_user_id = $2) ` +
        `and relationship_id in (${opsUtil.extractArrayIndices(relationshipIds, 3)})`;
    logger('Fetching user IDs with query: ', fetchQuery);
    const rawResult = await rdsConnection.selectQuery(fetchQuery, ['ACTIVE', referenceUserId, ...relationshipIds]);
    logger('Raw result of user ID fetch: ', rawResult);

    // could probably do this with some fun sql case statements but not worth it at present
    return rawResult.map((row) => {
        const userId = row['initiated_user_id'] === referenceUserId ? row['accepted_user_id'] : row['initiated_user_id'];
        return { userId, relationshipId: row['relationship_id'] };
    });
};
