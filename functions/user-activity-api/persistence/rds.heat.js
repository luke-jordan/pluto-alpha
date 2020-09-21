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

const addOptionalDates = ({ baseQuery, baseValues, startTime, endTime, querySuffix }) => {
    let query = baseQuery;
    const values = [...baseValues];
    
    if (startTime) {
        query = `${query} and creation_time > $${values.length + 1}`;
        values.push(startTime.format());
    }
    if (endTime) {
        query = `${query} and creation_time < $${values.length + 1}`;
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

    const { query, values } = addOptionalDates({ baseQuery, baseValues, startTime, endTime, querySuffix });
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

    const { query, values } = addOptionalDates({ baseQuery, baseValues, startTime, endTime, querySuffix });

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
module.exports.establishUserState = async (systemWideUserId) {
    const existenceCheck = await rdsConnection.selectQuery(`select current_period_points from ${heatStateTable} where system_wide_user_id = $1`, [systemWideUserId]);
    if (existenceCheck.length > 0) {
        logger('User state exists');
        return 'USER_EXISTS';
    }

    logger('User does not have heat state, insert blank record and continue');
    const insertionQuery = `insert into ${heatStateTable} values (system_wide_user_id) returning creation_time`;
    const resultOfInsert = await rdsConnection.insertRecords(insertionQuery, '${systemWideUserId', [{ systemWideUserId }]);

    return resultOfInsert;
}

module.exports.updateUserState = async ({ systemWideUserId, currentPeriodPoints, lastPeriodPoints, currentLevelId }) => {
    const updateDefinition = {
        table: heatStateTable,
        key: { systemWideUserId },
        value: { currentPeriodPoints, lastPeriodPoints, currentLevelId },
        returnClause: 'updated_time'
    };
    
    logger('Sending in heat state update: ', updateDefinition);
    await rdsConnection.updateRecordObject(updateDefinition);
    return { result: 'UPDATED' };
};
