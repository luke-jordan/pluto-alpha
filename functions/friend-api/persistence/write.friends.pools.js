'use strict';

const logger = require('debug')('jupiter:friends:pools:write');

const config = require('config');
const uuid = require('uuid/v4');

const util = require('ops-util-common');

const poolTable = config.get('tables.friendPoolTable');
const poolJoinTable = config.get('tables.friendPoolJoinTable');

const friendLogTable = config.get('tables.friendLogTable');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const DEFAULT_UNIT = 'HUNDREDTH_CENT';

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
        targetUnit,
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
        const participatorsJoinInsertionRows = participatingUsers.
            map(({ userId, relationshipId }) => ({ participationId: uuid(), savingPoolId, userId, relationshipId }));
        
        const participationInsertionDef = {
            query: `insert into ${poolJoinTable} (participation_id, saving_pool_id, user_id, relationship_id) values %L`,
            columnTemplate: '${participationId}, ${savingPoolId}, ${userId}, ${relationshipId}',
            rows: participatorsJoinInsertionRows
        };

        insertDefinitions.push(participationInsertionDef);

        const participatingUserLogRows = participatingUsers.
            map(({ userId, relationshipId }) => ({ logId: uuid(), savingPoolId, relationshipId, userId }));
        
        const participationLogDef = {
            query: `insert into ${friendLogTable} (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id) values %L`,
            columnTemplate: '${logId}, *{FRIEND_ADDED_TO_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}',
            rows: participatingUserLogRows
        };

        insertDefinitions.push(participationLogDef);
    }

    logger('Assembled insertion definitions: ', JSON.stringify(insertDefinitions, null, 2));
    const resultOfInsertion = await rdsConnection.largeMultiTableInsert(insertDefinitions);
    logger('Received back : ', resultOfInsertion);

    const persistedTimeRaw = resultOfInsertion[0]['creation_time'];
    return { savingPoolId, persistedTime: moment(persistedTimeRaw) };
};

module.exports.updateSavingPool = async (updateParams) => {
    logger('Updating a saving pool with params: ', updateParams);

    const { savingPoolId, updatingUserId } = updateParams;

    const existingPool = await rdsConnection.selectQuery();

    const updateDefinitions = [];
    const insertDefinitions = [];

    if (updateParams.poolName) {
        
    }

    if (updateParams.targetAmount) { 

    }

    if (updateParams.friendshipsToAdd) {

    }

};

