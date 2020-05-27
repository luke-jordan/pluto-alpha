'use strict';

const logger = require('debug')('jupiter:friend:saving-pool');

const util = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends.pools');

// ////////////////////////////////////////////////////////////
// ///////////////// READING POOLS ////////////////////////////
// ////////////////////////////////////////////////////////////

const listPoolsForUser = async ({ systemWideUserId }) => {
    const rawPools = await persistenceRead.fetchSavingPoolsForUser(systemWideUserId);
    logger('For user ', systemWideUserId, ' fetched raw pools : ', rawPools);
    if (!rawPools || rawPools.length === 0) {
        return [];
    }

    const poolIds = rawPools.map((savingPool) => savingPool.savingPoolId);
    const calculatedBalances = await persistenceRead.calculatePoolBalances(poolIds);
    logger('And retrieved calculated balances: ', calculatedBalances);

    const combinedPoolBalances = rawPools.map((rawPool) => {
        const balance = calculatedBalances.find((balanceDict) => balanceDict.savingPoolId === rawPool.savingPoolId);
        return {
            savingPoolId: rawPool.savingPoolId,
            creationTimeMillis: rawPool.creationTime.valueOf(),
            poolName: rawPool.poolName,
            target: { amount: rawPool.targetAmount, currency: rawPool.targetCurrency, unit: rawPool.targetUnit },
            current: { amount: balance.amount, currency: balance.currency, unit: balance.unit }
        };
    });
    
    logger('Assembled: ', combinedPoolBalances);
    return { currentSavingPools: combinedPoolBalances };
};

// NOTE : these relationship IDs are from the _creator_ of the pool to the participating user (if this becomes important in future, one extra call can replace them)
const fetchProfileWithKey = async (userIdFriendPair, addDefaultRelationshipId = 'CREATOR') => {
    const { userId, relationshipId } = userIdFriendPair;
    const rawProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: userId });
    
    const strippedProfile = {
        personalName: rawProfile.personalName,
        familyName: rawProfile.familyName
    };

    if (relationshipId) {
        strippedProfile.relationshipId = relationshipId;
    } else if (addDefaultRelationshipId) {
        strippedProfile.relationshipId = addDefaultRelationshipId;
    }

    return { userId, profile: strippedProfile };
};

const transformTransaction = (rawTransaction, profileMap, systemWideUserId) => ({
    transactionId: rawTransaction.transactionId,
    creationTimeMillis: rawTransaction.settlementTime.valueOf(),
    saveAmount: { amount: rawTransaction.amount, currency: rawTransaction.currency, unit: rawTransaction.unit },
    saveBySelf: rawTransaction.ownerUserId === systemWideUserId,
    saverName: `${profileMap[rawTransaction.ownerUserId].personalName} ${profileMap[rawTransaction.ownerUserId].familyName}`
});

const fetchPoolDetails = async ({ systemWideUserId }, { savingPoolId }) => {
    logger('Fetching pool with ID: ', savingPoolId, ' for user: ', systemWideUserId);

    const rawPool = await persistenceRead.fetchSavingPoolDetails(savingPoolId, true);
    logger('Received from persistence: ', rawPool);

    const transformedPool = {
        savingPoolId: rawPool.savingPoolId,
        creationTimeMillis: rawPool.creationTime.valueOf(),
        target: {
            amount: rawPool.targetAmount, unit: rawPool.targetUnit, currency: rawPool.targetCurrency
        },
        current: {
            amount: rawPool.currentAmount, unit: rawPool.currentUnit, currency: rawPool.currentCurrency 
        }
    };

    const participatingUserIds = rawPool.participatingUsers.map((userFriendPair) => userFriendPair.userId);
    if (!participatingUserIds.includes(systemWideUserId)) {
        return { result: 'ERROR', message: 'Not part of pool' };
    }

    const profileFetches = rawPool.participatingUsers.map((userFriendPair) => fetchProfileWithKey(userFriendPair));
    const userProfilesFetched = await Promise.all(profileFetches);
    const userProfileMap = userProfilesFetched.reduce((obj, entry) => ({ ...obj, [entry.userId]: entry.profile }), {});
    logger('Assembled profile map: ', userProfileMap);

    transformedPool.creatingUser = userProfileMap[rawPool.creatingUserId];
    transformedPool.participatingUsers = Object.values(userProfileMap);

    // in case some transaction was by a user who is no longer in the pool (not )
    const transactionUserIds = rawPool.transactionRecord.map((transaction) => transaction.ownerUserId);
    const removedUserIds = transactionUserIds.filter((userId) => !participatingUserIds.includes(userId));
    logger('Any removed user IDs ? : ', removedUserIds);

    if (removedUserIds.length > 0) {
        const priorUserProfilesFetched = await Promise.all(transactionUserIds.map((userId) => fetchProfileWithKey({ userId }, false)));
        priorUserProfilesFetched.forEach((entry) => { 
            userProfileMap[entry.userId] = entry.profile; 
        }); // maybe do with a reduce in future
    }

    logger('Transforming transaction records');
    transformedPool.transactionRecord = rawPool.transactionRecord.map((transaction) => transformTransaction(transaction, userProfileMap, systemWideUserId));
    logger('Result of pool fetch & transform: ', JSON.stringify(transformedPool, null, 2));
    return transformedPool;
};

const readDispatcher = {
    'list': (userDetails) => listPoolsForUser(userDetails),
    'fetch': (userDetails, params) => fetchPoolDetails(userDetails, params)
};

module.exports.readSavingPool = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { operation, params } = util.extractPathAndParams(event);

        const resultOfOperation = await readDispatcher[operation](userDetails, params);
        if (!resultOfOperation || resultOfOperation.result === 'ERROR') {
            return { statusCode: 400, message: 'Bad request' };
        }

        return { statusCode: 200, body: JSON.stringify(resultOfOperation) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, message: err.message };
    }
};

// ////////////////////////////////////////////////////////////
// ///////////////// WRITING POOLS ////////////////////////////
// ////////////////////////////////////////////////////////////

const createSavingPool = async (params, { systemWideUserId }) => {
    logger('Creating a pool with params: ', params);

    const { name, target, friendships } = params;
    const friendUserIds = await (friendships.length > 0 ? persistenceRead.obtainFriendIds(friendships) : []);
    if (friendUserIds.length < friendships.length) {
        return { result: 'ERROR', message: 'User trying to involve non-friends' };
    }

    const persistenceObject = {
        poolName: name.trim(),
        creatingUserId: systemWideUserId,
        targetAmount: target.amount,
        targetUnit: target.unit,
        targetCurrency: target.currency,
        participatingUsers: friendUserIds
    };

    logger('Handler sending to persistence new pool: ', persistenceObject);
    const resultOfCreation = await persistenceWrite.persistNewSavingPool(persistenceObject);
    logger('Result of pool creation: ', resultOfCreation);
    
    const { savingPoolId } = resultOfCreation;

    const createdSavingPool = await fetchPoolDetails({ systemWideUserId }, { savingPoolId });
    
    return { result: 'SUCCESS', createdSavingPool };
};

const updateSavingPool = async (params, { systemWideUserId }) => {
    logger('Updating a saving pool with params: ', params);
    const { savingPoolId } = params;

    const poolInfo = await persistenceRead.fetchSavingPoolDetails(savingPoolId, false);
    logger('Basic info on pool as stands: ', poolInfo);

    const { creatingUserId } = poolInfo;
    // for the moment we do this; in future may allow other participants
    if (creatingUserId !== systemWideUserId) {
        return { result: 'ERROR', message: 'Trying to modify pool but not creator' };
    }

    // also at present we only do one at a time
    const persistenceArgs = { savingPoolId, updatingUserId: systemWideUserId };
    
    if (params.friendshipsToAdd) {
        const friendshipIds = params.friendshipsToAdd;
        persistenceArgs.friendshipsToAdd = await persistenceRead.obtainFriendIds(systemWideUserId, friendshipIds);
    } else if (params.name) {
        persistenceArgs.poolName = params.name;
    } else if (params.target) {
        const { target } = params;
        persistenceArgs.targetAmount = target.amount;
        persistenceArgs.targetUnit = target.unit;
        persistenceArgs.targetCurrency = target.currency;
    }

    logger('Updating in persistence with: ', persistenceArgs);
    const resultOfUpdate = await persistenceWrite.updateSavingPool(persistenceArgs);
    logger('Result from persistence: ', resultOfUpdate);

    return { result: 'SUCCESS', updatedTime: resultOfUpdate.updatedTime.valueOf() };
};

module.exports.writeSavingPool = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { operation, params } = util.extractPathAndParams(event);

        let resultOfOperation = null;
        if (operation === 'create') {
            resultOfOperation = await createSavingPool(params, util.extractUserDetails(event));
        }
        if (operation === 'update') {
            resultOfOperation = await updateSavingPool(params, util.extractUserDetails(event));
        }

        if (!resultOfOperation) {
            return { statusCode: 400, message: 'Unknown operation' };
        }

        if (resultOfOperation.result === 'SUCCESS') {
            return { statusCode: 200, body: JSON.stringify(resultOfOperation) };
        }

        return { statusCode: 400, body: JSON.stringify(resultOfOperation) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, message: err.message };
    }
};
