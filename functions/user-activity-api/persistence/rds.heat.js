'use strict';

const logger = require('debug')('jupiter:heat:rds');
const config = require('config');

const opsUtil = require('ops-util-common');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const eventPointTable = config.get('tables.pointHeatDefinition');
const pointLogTable = config.get('tables.heatPointsLedger');
const heatStateTable = config.get('tables.heatStateLedger');
const heatLevelTable = config.get('tables.heatLevelThreshold');

const addOptionalRefDates = ({ baseQuery, baseValues, startTime, endTime, querySuffix }) => {
    let query = baseQuery;
    const values = [...baseValues];
    
    if (startTime) {
        query = `${query} and reference_time > $${values.length + 1}`;
        values.push(startTime.format());
    }
    if (endTime) {
        query = `${query} and reference_time < $${values.length + 1}`;
        values.push(endTime.format());
    }
    if (querySuffix) {
        query = `${query} ${querySuffix}`;
    }

    return { query, values };
};

module.exports.filterForPointRelevance = async (eventTypes) => {
    const query = `select event_type from ${eventPointTable} where number_points > 0 and active = true` +
        ` and event_type in (${opsUtil.extractArrayIndices(eventTypes)})`;
    const resultOfFetch = await rdsConnection.selectQuery(query, eventTypes);
    return resultOfFetch.map((row) => row['event_type']);  
};

module.exports.obtainPointsForEvent = async (clientId, floatId, eventType) => {
    const query = `select event_point_match_id, number_points, parameters from ${eventPointTable} ` +
        `where client_id = $1 and float_id = $2 and event_type = $3`;
    const resultOfFetch = await rdsConnection.selectQuery(query, [clientId, floatId, eventType]);
    return resultOfFetch.length > 0 ? camelCaseKeys(resultOfFetch[0]) : null; 
};

module.exports.sumPointsForUsers = async (userIds, startTime, endTime) => {
    const baseQuery = `select owner_user_id, sum(number_points) from ${pointLogTable} where ` +
        `owner_user_id in (${opsUtil.extractArrayIndices(userIds)})`;
    const querySuffix = `group by owner_user_id`;
    const baseValues = [...userIds];

    const { query, values } = addOptionalRefDates({ baseQuery, baseValues, startTime, endTime, querySuffix });
    const resultOfFetch = await rdsConnection.selectQuery(query, values);
    // and finally normalize
    return resultOfFetch.reduce((obj, row) => ({ ...obj, [row['owner_user_id']]: row['sum']}), {});
};

module.exports.obtainPointHistory = async (userId, startTime, endTime) => {
    const joinColumn = 'event_point_match_id';
    const baseQuery = `select ${pointLogTable}.*, ${eventPointTable}.event_type from ` +
        `${pointLogTable} inner join ${eventPointTable} on ${pointLogTable}.${joinColumn} = ${eventPointTable}.${joinColumn} ` +
        `where ${pointLogTable}.owner_user_id = $1`;
    const querySuffix = 'order by creation_time desc';
    const baseValues = [userId];

    const { query, values } = addOptionalRefDates({ baseQuery, baseValues, startTime, endTime, querySuffix });

    logger('Obtaining point history with assembled query: ', query);

    const resultOfQuery = await rdsConnection.selectQuery(query, values);
    return resultOfQuery.map(camelCaseKeys);
};

module.exports.obtainPointLevels = async (clientId, floatId) => {
    const query = `select * from ${config.get('tables.heatLevelThreshold')} where client_id = $1 and float_id = $2 order by minimum_points desc`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [clientId, floatId]);
    return camelCaseKeys(resultOfQuery);
};

// some validation would probably be useful later, as well as handling objects with varying keys (e.g., context present/not)
module.exports.insertPointLogs = async (userEventPointObjects) => {
    const insertionQuery = `insert into ${pointLogTable} (owner_user_id, event_point_match_id, number_points, reference_time) values %L`;
    
    const insertionObjects = (userEventPointObjects).map((object) => (
        { userId: object.userId, pointMatchId: object.eventPointMatchId, numberPoints: object.numberPoints, referenceTime: object.referenceTime }
    ));
    const columnTemplate = opsUtil.extractColumnTemplate(Object.keys(insertionObjects[0]));
    
    logger('Inserting point log with query: ', insertionQuery, ' and records: ', JSON.stringify(insertionObjects));
    const resultOfInsert = await rdsConnection.insertRecords(insertionQuery, columnTemplate, insertionObjects);
    logger('Result of insertion: ', JSON.stringify(resultOfInsert));
    
    return { result: 'INSERTED' };
};

// we use this to record the user current state, inserting first if it does not exist in state table
module.exports.establishUserState = async (systemWideUserId) => {
    const existenceCheck = await rdsConnection.selectQuery(`select current_period_points from ${heatStateTable} where system_wide_user_id = $1`, [systemWideUserId]);
    if (existenceCheck.length > 0) {
        logger('User state exists');
        return 'USER_EXISTS';
    }

    logger('User does not have heat state, insert blank record and continue');
    const insertionQuery = `insert into ${heatStateTable} (system_wide_user_id) values %L returning creation_time`;
    const resultOfInsert = await rdsConnection.insertRecords(insertionQuery, '${systemWideUserId}', [{ systemWideUserId }]);

    return resultOfInsert;
};

module.exports.updateUserState = async ({ systemWideUserId, currentPeriodPoints, priorPeriodPoints, currentLevelId }) => {
    const updateDefinition = {
        table: heatStateTable,
        key: { systemWideUserId },
        value: { currentPeriodPoints, priorPeriodPoints, currentLevelId },
        returnClause: 'updated_time'
    };
    
    logger('Sending in heat state update: ', updateDefinition);
    await rdsConnection.updateRecordObject(updateDefinition);
    return { result: 'UPDATED' };
};

// maybe do an 'active' flag in the future, or filter by whether any point logs in prior period + this period, but all overkill for now
module.exports.obtainAllUsersWithState = async () => {
    const queryResult = await rdsConnection.selectQuery(`select system_wide_user_id from ${heatStateTable}`, []);
    logger('Obtained ', queryResult.length, ' rows of user state');
    return queryResult.map((row) => row['system_wide_user_id']);
};

// could possibly find a way to wrap this into queries above, but is a fairly rapid call
module.exports.obtainUserLevels = async (userIds, includeLevelDetails = false) => {
    const whereClause = `where system_wide_user_id in (${opsUtil.extractArrayIndices(userIds)})`;
    
    const fullDetailSelection = `select system_wide_user_id, level_name, level_color, level_color_code from ` +
        `${heatStateTable} inner join ${heatLevelTable} on ${heatStateTable}.current_level_id = ${heatLevelTable}.level_id`;
    const strippedSelection = `select system_wide_user_id, current_level_id from ${heatStateTable}`;
    
    const fetchQuery = `${includeLevelDetails ? fullDetailSelection : strippedSelection} ${whereClause}`;
    const queryResult = await rdsConnection.selectQuery(fetchQuery, userIds);

    const rowExtraction = (row) => (includeLevelDetails ? camelCaseKeys(row) : row['current_level_id']);    
    return queryResult.reduce((obj, row) => ({ ...obj, [row['system_wide_user_id']]: rowExtraction(row) }), {});
};

module.exports.fetchUserLevel = async (userId) => {
    const fetchQuery = `select prior_period_points as user_points_prior, current_period_points as user_points_current, ` +
        `level_name, level_color, level_color_code, minimum_points ` +
        `from ${heatStateTable} inner join ${heatLevelTable} on ${heatStateTable}.current_level_id = ${heatLevelTable}.level_id ` +
        `where system_wide_user_id = $1`;
    const queryResult = await rdsConnection.selectQuery(fetchQuery, [userId]);
    return queryResult.length > 0 ? camelCaseKeys(queryResult[0]) : null;
};

// we use this because some consumers of multi-user heat, i.e., friends, needs to know latest activity too
module.exports.obtainLatestActivities = async (userIds, txTypesToInclude) => {
    const txTable = config.get('tables.accountTransactions');
    const accountTable = config.get('tables.accountLedger');

    const fetchQuery = `select owner_user_id, transaction_type, max(${txTable}.creation_time) as latest_time from ` +
        `${txTable} inner join ${accountTable} on ${txTable}.account_id = ${accountTable}.account_id ` +
        `where owner_user_id in (${opsUtil.extractArrayIndices(userIds)}) ` +
        `and transaction_type in (${opsUtil.extractArrayIndices(txTypesToInclude, userIds.length + 1)}) ` +
        `group by owner_user_id, transaction_type`;

    logger('Obtaining latest activities using query: ', fetchQuery);
    const queryResults = await rdsConnection.selectQuery(fetchQuery, [...userIds, ...txTypesToInclude]);
    
    const usersConsolidated = new Map();
    queryResults.forEach((row) => {
        const currentUserState = { ...usersConsolidated.get(row['owner_user_id']) } || {};
        currentUserState[row['transaction_type']] = { creationTime: row['latest_time'] };
        usersConsolidated.set(row['owner_user_id'], currentUserState);
    });

    logger('Consolidated user activity, have: ', usersConsolidated);
    return userIds.reduce((obj, userId) => ({ ...obj, [userId]: usersConsolidated.get(userId) || {} }), {});
};
