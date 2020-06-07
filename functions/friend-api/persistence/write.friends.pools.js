'use strict';

const logger = require('debug')('jupiter:friends:pools:write');
const config = require('config');

const uuid = require('uuid/v4');
const moment = require('moment');
const camelCaseKeys = require('camelcase-keys');

const util = require('ops-util-common');

const poolTable = config.get('tables.friendPoolTable');
const poolJoinTable = config.get('tables.friendPoolJoinTable');

const friendLogTable = config.get('tables.friendLogTable');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const DEFAULT_UNIT = 'HUNDREDTH_CENT';

const assembleUserJoinInserts = (participatingUsers, savingPoolId) => {
    const participatorsJoinInsertionRows = participatingUsers.
            map(({ userId, relationshipId }) => ({ participationId: uuid(), savingPoolId, userId, relationshipId }));
        
    const participationInsertionDef = {
        query: `insert into ${poolJoinTable} (participation_id, saving_pool_id, user_id, relationship_id) values %L returning creation_time`,
        columnTemplate: '${participationId}, ${savingPoolId}, ${userId}, ${relationshipId}',
        rows: participatorsJoinInsertionRows
    };

    const participatingUserLogRows = participatingUsers.
        map(({ userId, relationshipId }) => ({ logId: uuid(), savingPoolId, relationshipId, userId }));
    
    const participationLogDef = {
        query: `insert into ${friendLogTable} (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id) values %L`,
        columnTemplate: '${logId}, *{FRIEND_ADDED_TO_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}',
        rows: participatingUserLogRows
    };

    return { participationInsertionDef, participationLogDef };
};

module.exports.persistNewSavingPool = async (savingPool) => {
    logger('Persisting new saving pool, passed: ', savingPool);

    const savingPoolId = uuid();

    const { targetAmount: inputAmount, targetUnit: inputUnit, targetCurrency } = savingPool;
    const targetAmount = util.convertToUnit(inputAmount, inputUnit, DEFAULT_UNIT);

    const { creatingUserId } = savingPool;

    const primaryObject = {
        savingPoolId,
        creatingUserId,
        targetAmount,
        targetUnit: DEFAULT_UNIT,
        targetCurrency,
        poolName: savingPool.poolName
    };

    const insertDefinitions = [];

    const primaryInsertion = {
        query: `insert into ${poolTable} (${util.extractQueryClause(Object.keys(primaryObject))}) values %L returning creation_time`,
        columnTemplate: util.extractColumnTemplate(Object.keys(primaryObject)),
        rows: [primaryObject]
    };

    insertDefinitions.push(primaryInsertion);

    // separate to others because no relationship ID for self, at present
    const creatorJoinInsertion = {
        query: `insert into ${poolJoinTable} (participation_id, saving_pool_id, user_id) values %L`,
        columnTemplate: '${participationId}, ${savingPoolId}, ${creatingUserId}',
        rows: [{ participationId: uuid(), savingPoolId, creatingUserId }]
    };

    insertDefinitions.push(creatorJoinInsertion);

    const poolCreationLogDef = {
        query: `insert into ${friendLogTable} (log_id, log_type, saving_pool_id, relevant_user_id) values %L`,
        columnTemplate: '${logId}, *{SAVING_POOL_CREATED}, ${savingPoolId}, ${creatingUserId}',
        rows: [{ logId: uuid(), savingPoolId, creatingUserId }]
    };

    insertDefinitions.push(poolCreationLogDef);

    // remove self in case included
    const participatingUsers = savingPool.participatingUsers ? savingPool.participatingUsers.
        filter((userRelPair) => userRelPair && userRelPair.userId !== creatingUserId) : [];
        
    if (participatingUsers.length > 0) {
        const { participationInsertionDef, participationLogDef } = assembleUserJoinInserts(participatingUsers, savingPoolId);
        insertDefinitions.push(participationInsertionDef, participationLogDef);
    }

    logger('Assembled insertion definitions: ', JSON.stringify(insertDefinitions, null, 2));
    const resultOfInsertion = await rdsConnection.largeMultiTableInsert(insertDefinitions);
    logger('Received back : ', resultOfInsertion);

    const persistedTimeRaw = resultOfInsertion[0][0]['creation_time'];
    return { savingPoolId, persistedTime: moment(persistedTimeRaw) };
};

const assembleAddFriendsToPoolDefs = async (savingPoolId, friendshipsToAdd) => {
    const existingFriendQuery = `select participation_id, relationship_id, user_id, active from ${poolJoinTable} where saving_pool_id = $1 ` +
        `and user_id in (${util.extractArrayIndices(friendshipsToAdd, 2)})`;
    const extractedUserIds = friendshipsToAdd.map((userRelPair) => userRelPair.userId);
    const existingJoins = await rdsConnection.selectQuery(existingFriendQuery, [savingPoolId, ...extractedUserIds]);

    logger('Existing relevant participation: ', existingJoins);

    const updateDefinitions = [];
    const insertDefinitions = [];

    const existingUserIds = existingJoins.map((row) => row['user_id']);
    const inactiveUserIds = existingJoins.filter((row) => !row['active']).map((row) => row['user_id']);
    logger('User Ids of prior but now inactive participants: ', inactiveUserIds);

    const pairsToUpdate = friendshipsToAdd.filter(({ userId }) => inactiveUserIds.includes(userId));
    const pairsToAdd = friendshipsToAdd.filter(({ userId }) => !existingUserIds.includes(userId));

    if (pairsToUpdate.length > 0) {
        const participationPairs = existingJoins.map((row) => camelCaseKeys(row)).filter((row) => inactiveUserIds.includes(row.userId));
        logger('Participation pairs to update: ', participationPairs);
        
        // there is a more efficient pure update method that can do batches better than this, but not worth it until needed
        const reactivateDefs = participationPairs.map(({ participationId }) => ({
            table: poolJoinTable,
            key: { participationId },
            value: { active: true },
            returnClause: 'updated_time'
        }));
        logger('Reactivate definitions: ', reactivateDefs);
        updateDefinitions.push(...reactivateDefs);

        const logRows = participationPairs.map(({ userId, relationshipId }) => ({
            logId: uuid(), userId, savingPoolId, relationshipId, logContext: { reactivation: true }
        }));

        const logInsertDef = {
            query: `insert into ${friendLogTable} (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id, log_context) values %L`,
            columnTemplate: '${logId}, *{FRIEND_READDED_TO_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}, ${logContext}',
            rows: logRows
        };

        insertDefinitions.push(logInsertDef);
    }

    if (pairsToAdd.length > 0) {
        const { participationInsertionDef, participationLogDef } = assembleUserJoinInserts(pairsToAdd, savingPoolId);
        insertDefinitions.push(participationInsertionDef, participationLogDef);
    }

    return { updateDefinitions, insertDefinitions };
};

module.exports.updateSavingPool = async (updateParams) => {
    logger('Updating a saving pool with params: ', updateParams);

    const { savingPoolId, updatingUserId } = updateParams;

    const existingPoolResult = await rdsConnection.selectQuery(`select * from ${poolTable} where saving_pool_id = $1`, [savingPoolId]);
    logger('Saving pool as in DB: ', existingPoolResult);

    if (!existingPoolResult || existingPoolResult.length === 0) {
        throw Error('Trying to update non-existent pool');
    }

    const existingPool = camelCaseKeys(existingPoolResult[0]);
    if (existingPool.creatingUserId !== updatingUserId) {
        return { result: 'ERROR', message: 'Only creating user can update at present' };
    }

    const changeFields = [];
    const updateDefinitions = [];
    const insertDefinitions = [];

    const baseUpdateDef = {
        table: poolTable,
        key: { savingPoolId },
        returnClause: 'updated_time'
    };

    if (updateParams.poolName) {
        changeFields.push({
            fieldName: 'poolName',
            oldValue: existingPool.poolName,
            newValue: updateParams.poolName
        });

        updateDefinitions.push({ 
            ...baseUpdateDef, 
            value: { poolName: updateParams.poolName }
        });
    }

    if (updateParams.targetAmount) { 
        // so we only have to change the amount, convert new target to old unit
        const newTargetAmount = util.convertToUnit(updateParams.targetAmount, updateParams.targetUnit, existingPool.targetUnit);
        changeFields.push({
            fieldName: 'targetAmount',
            oldValue: existingPool.targetAmount,
            newValue: newTargetAmount
        });

        updateDefinitions.push({
            ...baseUpdateDef,
            value: { targetAmount: newTargetAmount }
        });
    }

    if (updateParams.friendshipsToAdd) {
        // complicated beast, so hand off and carry on
        const { 
            updateDefinitions: addingFriendUpdates, 
            insertDefinitions: addingFriendInserts 
        } = await assembleAddFriendsToPoolDefs(savingPoolId, updateParams.friendshipsToAdd);
        updateDefinitions.push(...addingFriendUpdates);
        insertDefinitions.push(...addingFriendInserts);
    }

    logger('Updating saving pool, assembled update definitions: ', updateDefinitions);
    logger('And insert definitions, aside from update logs: ', insertDefinitions);

    if (updateDefinitions.length === 0 && insertDefinitions.length === 0) {
        throw Error('Error, nothing to do!');
    }

    // if we are just adding friendships, there might be no updates, just inserts
    if (updateDefinitions.length === 0) {
        logger('No update definitions, only inserts');
        const resultOfInsertion = await rdsConnection.largeMultiTableInsert(insertDefinitions);
        logger('Insertion result: ', resultOfInsertion);
        // insertion of the join stands for the update
        return { updatedTime: moment(resultOfInsertion[0][0]['creation_time']) };
    }

    const updateLog = { 
        logId: uuid(),
        savingPoolId,
        userId: updatingUserId,
        logContext: { changeFields }
    };

    const logInsertDef = {
        query: `insert into ${friendLogTable} (log_id, log_type, saving_pool_id, relevant_user_id, log_context) values %L`,
        columnTemplate: '${logId}, *{SAVING_POOL_UPDATE}, ${savingPoolId}, ${updatingUserId}, ${logContext}',
        rows: [updateLog]
    };

    logger('Inserting friend log via: ', logInsertDef);
    insertDefinitions.push(logInsertDef);

    const resultOfUpdate = await rdsConnection.multiTableUpdateAndInsert(updateDefinitions, insertDefinitions);
    logger('Result of update queries: ', resultOfUpdate);

    const updatedTime = moment(resultOfUpdate[0][0]['updated_time']);
    
    return { updatedTime }; 
};

module.exports.removeTransactionsFromPool = async (savingPoolId, transactionIds) => {
    logger('Removing from pool: ', savingPoolId, ' transactions: ', transactionIds);
    const updateQuery = `update ${config.get('tables.transactionTable')} set tags = array_remove(tags, $1) where ` +
        `transaction_id in (${util.extractArrayIndices(transactionIds, 2)}) returning updated_time`;
    const updateValues = [`SAVING_POOL::${savingPoolId}`, ...transactionIds];
    
    logger('Updating with query: ', updateQuery, ' and values: ', updateValues);
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, updateValues);
    logger('Raw result: ', resultOfUpdate);

    return Array.isArray(resultOfUpdate.rows) ? resultOfUpdate.rows.map((row) => ({ updatedTime: moment(row['updated_time']) })) : null;
};
