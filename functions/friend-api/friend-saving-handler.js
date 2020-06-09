'use strict';

const logger = require('debug')('jupiter:friend:saving-pool');
const moment = require('moment');

const publisher = require('publish-common');
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
        poolName: rawPool.poolName,
        creationTimeMillis: rawPool.creationTime.valueOf(),
        createdByFetcher: rawPool.creatingUserId === systemWideUserId,
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

const publishFriendAddedToPool = async ({ friendUserIds, creatingUserId, poolName, savingPoolId }) => {
    const { personalName, calledName } = await persistenceRead.fetchUserProfile({ systemWideUserId: creatingUserId });
    
    const friendName = calledName || personalName;
    const messageParameters = { poolName, friendName };

    const userIds = friendUserIds.map(({ userId }) => userId);
    const context = { messageParameters, savingPoolId };

    return publisher.publishMultiUserEvent(userIds, 'ADDED_TO_FRIEND_SAVING_POOL', { context, initiator: creatingUserId });
};

const createSavingPool = async ({ systemWideUserId }, params) => {
    logger('Creating a pool with params: ', params);

    const { name, target, friendships } = params;
    const friendUserIds = await (friendships.length > 0 ? persistenceRead.obtainFriendIds(systemWideUserId, friendships) : []);
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
    
    const publishCreatorEvent = publisher.publishUserEvent(systemWideUserId, 'CREATED_SAVING_POOL', { context: { savingPoolId }});
    const friendPublishEvents = publishFriendAddedToPool({ 
        friendUserIds, 
        creatingUserId: systemWideUserId, 
        poolName: persistenceObject.poolName,
        savingPoolId
    });
    await Promise.all([publishCreatorEvent, friendPublishEvents]);

    return { result: 'SUCCESS', createdSavingPool };
};

const handleGenericChanges = (params, poolInfo, systemWideUserId) => {
    const persistenceArgs = {};
    const eventPromises = [];

    const { savingPoolId } = params;

    if (params.name) {
        persistenceArgs.poolName = params.name;
        const logContext = { priorName: poolInfo.poolName, newName: params.name, savingPoolId };
        eventPromises.push(publisher.publishUserEvent(systemWideUserId, 'MODIFIED_SAVING_POOL', { context: logContext }));
    }

    if (params.target) {
        const { target } = params;
        persistenceArgs.targetAmount = target.amount;
        persistenceArgs.targetUnit = target.unit;
        persistenceArgs.targetCurrency = target.currency;
        const logContext = { newTarget: target, oldTargetAmount: poolInfo.targetAmount, oldTargetUnit: poolInfo.targetUnit, savingPoolId };
        eventPromises.push(publisher.publishUserEvent(systemWideUserId, 'MODIFIED_SAVING_POOL', { context: logContext }));
    }

    return { persistenceArgs, eventPromises };
};

const handleRemovingFriend = async (creatingUserId, savingPoolId, friendshipToRemove) => {
    const [friendUserId, savingPoolDetails, creatorProfile] = await Promise.all([
        persistenceRead.obtainFriendIds(creatingUserId, [friendshipToRemove]),
        persistenceRead.fetchSavingPoolDetails(savingPoolId, true),
        persistenceRead.fetchUserProfile({ systemWideUserId: creatingUserId })
    ]);
    logger('Found friend user pair for this user: ', friendUserId);

    const { userId } = friendUserId[0];
    logger('Removing transactions for user: ', userId);
    const userTransactions = savingPoolDetails.transactionRecord.
        filter((transaction) => transaction.ownerUserId === userId).
        map(({ transactionId }) => transactionId);
    
    // note : update to pool itself is handled as bundle, below
    await persistenceWrite.removeTransactionsFromPool(savingPoolId, userTransactions);
    
    const creatorContext = { savingPoolId, removedFriend: friendUserId };
    const messageParameters = { friendName: creatorProfile.calledName || creatorProfile.firstName, poolName: savingPoolDetails.poolName };
    const friendContext = { savingPoolId, messageParameters };

    const eventPromises = [
        publisher.publishUserEvent(creatingUserId, 'MODIFIED_SAVING_POOL', { context: creatorContext }),
        publisher.publishUserEvent(userId, 'REMOVED_FROM_FRIEND_SAVING_POOL', { initiator: creatingUserId, context: friendContext })
    ];
    
    return { eventPromises, friendUserId };
};

const updateSavingPool = async ({ systemWideUserId }, params) => {
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
    let persistenceArgs = { savingPoolId, updatingUserId: systemWideUserId };

    // could send multiple of these in time, so doing this way for now
    const userEventPublishPromises = [];

    if (params.friendshipsToAdd) {
        const friendshipIds = params.friendshipsToAdd;
        const friendUserIds = await persistenceRead.obtainFriendIds(systemWideUserId, friendshipIds);
        persistenceArgs.friendshipsToAdd = friendUserIds;
        userEventPublishPromises.push(publisher.publishUserEvent(systemWideUserId, 'MODIFIED_SAVING_POOL', { context: { friendUserIds, savingPoolId } }));
        userEventPublishPromises.push(publishFriendAddedToPool({ friendUserIds, creatingUserId: systemWideUserId, poolName: poolInfo.poolName, savingPoolId }));
    } else if (params.name || params.target) {
        const { persistenceArgs: argsToAdd, eventPromises } = handleGenericChanges(params, poolInfo, systemWideUserId);
        userEventPublishPromises.push(...eventPromises);
        persistenceArgs = { ...persistenceArgs, ...argsToAdd };
    } else if (params.friendshipToRemove) {
        const { friendUserId, eventPromises } = await handleRemovingFriend(systemWideUserId, savingPoolId, params.friendshipToRemove);
        persistenceArgs.friendshipsToRemove = friendUserId;
        userEventPublishPromises.push(...eventPromises);
    }

    logger('Updating in persistence with: ', persistenceArgs);
    const resultOfUpdate = await persistenceWrite.updateSavingPool(persistenceArgs);
    logger('Result from persistence: ', resultOfUpdate);

    logger('Publishing user events');
    await Promise.all(userEventPublishPromises);
    logger('Publication complete');

    // note : sending back the updated pool would require doing the whole of read pool's job, because consumer would
    // expect it in the same form; hence, rather just require reload from frontend if it wants to refresh
    return { result: 'SUCCESS', updatedTime: resultOfUpdate.updatedTime.valueOf() };
};

const removeTransaction = async ({ systemWideUserId }, { savingPoolId, transactionId }) => {
    const savingPoolDetails = await persistenceRead.fetchSavingPoolDetails(savingPoolId, true);
    logger('Retrieved saving pool detials: ', savingPoolDetails);

    // check if transaction belongs to user (not user in pool or not, in case somehow admin removed)
    const transaction = savingPoolDetails.transactionRecord.find((tx) => tx.transactionId === transactionId);
    logger('Found transaction: ', transaction, ' checking vs: ', systemWideUserId);
    if (!transaction || transaction.ownerUserId !== systemWideUserId) {
        return { result: 'ERROR', message: 'Transaction does not exist or is not this user' };
    }
    
    const updateResult = await persistenceWrite.removeTransactionsFromPool(savingPoolId, [transactionId]);
    logger('Result of update: ', updateResult);

    const logContext = { transactionId, savingPoolId };
    await publisher.publishUserEvent(systemWideUserId, 'RETRACTED_FROM_SAVING_POOL', { context: logContext });

    const updatedTime = updateResult && updateResult.length === 1 ? updateResult[0].updatedTime.valueOf() : moment().valueOf();
    return { result: 'SUCCESS', updatedTime };
};

const deactivateSavingPool = async ({ systemWideUserId }, { savingPoolId }) => { 
    const savingPoolDetails = await persistenceRead.fetchSavingPoolDetails(savingPoolId, true);
    if (!savingPoolDetails || savingPoolDetails.creatingUserId !== systemWideUserId) {
        return { result: 'ERROR', message: 'Trying to modify pool but not creator' };
    }

    const updateResult = await persistenceWrite.updateSavingPool({ savingPoolId, active: false, updatingUserId: systemWideUserId });
    logger('Update result from deactivating pool: ', updateResult);

    const { participatingUsers } = savingPoolDetails;
    
    const nonCreatorUserIds = participatingUsers.map(({ userId }) => userId).filter((userId) => userId !== systemWideUserId);

    const { personalName, calledName } = await persistenceRead.fetchUserProfile({ systemWideUserId });
    const logContextFriend = {
        savingPoolId,
        messageParameters: { poolName: savingPoolDetails.poolName, friendName: calledName || personalName }
    };

    const creatorOptions = { context: { savingPoolId, active: false }};
    const friendOptions = { initiator: systemWideUserId, context: logContextFriend };

    await Promise.all([
        publisher.publishMultiUserEvent(nonCreatorUserIds, 'SAVING_POOL_DEACTIVATED_BY_CREATOR', friendOptions),
        publisher.publishUserEvent(systemWideUserId, 'DEACTIVATED_SAVING_POOL', creatorOptions)
    ]);

    return { result: 'SUCCESS', updatedTime: updateResult.updatedTime.valueOf() };
};

const writeDispatcher = {
    'create': (userDetails, params) => createSavingPool(userDetails, params),
    'update': (userDetails, params) => updateSavingPool(userDetails, params),
    'retract': (userDetails, params) => removeTransaction(userDetails, params),
    'deactivate': (userDetails, params) => deactivateSavingPool(userDetails, params)
};

module.exports.writeSavingPool = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { operation, params } = util.extractPathAndParams(event);
        logger('Handling operation: ', operation, ' with params: ', params);

        if (!Object.keys(writeDispatcher).includes(operation)) {
            return { statusCode: 400, message: 'Unknown operation' };
        }

        const resultOfOperation = await writeDispatcher[operation](userDetails, params);

        if (resultOfOperation.result === 'SUCCESS') {
            return { statusCode: 200, body: JSON.stringify(resultOfOperation) };
        }

        return { statusCode: 400, body: JSON.stringify(resultOfOperation) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, message: err.message };
    }
};
