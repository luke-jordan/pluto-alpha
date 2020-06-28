'use strict';

const logger = require('debug')('jupiter:user-notifications:rds');
const config = require('config');
const camelcase = require('camelcase');

const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const moment = require('moment');
const rdsConnection = new RdsConnection(config.get('db'));

const camelCaseKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [camelcase(key)]: object[key] }), {});

// ///////////////////////////////////////////////////////////////////////////////////////
// /////////////////////// Final: push token extraction begins here //////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////

module.exports.insertPushToken = async (pushTokenObject) => {
    const insertionQueryArray = [
        'userId', 'pushProvider', 'pushToken'
    ];
    const insertionQuery = `insert into ${config.get('tables.pushTokenTable')} (${opsUtil.extractQueryClause(insertionQueryArray)}) values %L returning insertion_id, creation_time`;
    const insertionColumns = opsUtil.extractColumnTemplate(insertionQueryArray);

    const insertArray = [pushTokenObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    logger('Push token insertion resulted in:', databaseResponse);
    return databaseResponse.rows.map((insertionResult) => camelCaseKeys(insertionResult));
};

module.exports.getPushTokens = async (userIds, provider) => {
    const haveProvider = typeof provider === 'string';
    const idParamIdxs = opsUtil.extractArrayIndices(userIds, haveProvider ? 2 : 1);
    
    // note : ordering by creation time ascending means that the dict assembly will retain only the most recently
    // created in the edge case where provider is not given and there are duplicates for a user id (todo : test this)
    const query = `select user_id, push_token from ${config.get('tables.pushTokenTable')} where active = true and ` +
        `${haveProvider ? 'push_provider = $1 and ' : ''} user_id in (${idParamIdxs}) order by creation_time asc`;
    const values = haveProvider ? [provider, ...userIds] : userIds;
    
    logger('Query for tokens: ', query);
    logger('Values for tokens: ', values);

    const result = await rdsConnection.selectQuery(query, values);
    logger('Got this back from user push token extraction:', result);

    return result.reduce((obj, row) => ({ ...obj, [row['user_id']]: row['push_token']}), {});
};

module.exports.deactivatePushToken = async (provider, userId) => {
    logger('About to update push token.');
    const table = config.get('tables.pushTokenTable');
    const key = { userId, provider };
    const value = { active: false };
    const returnClause = 'insertion_time';

    const response = await rdsConnection.updateRecordObject({ table, key, value, returnClause });
    logger('Push token deactivation resulted in:', response);

    return response.map((deactivationResult) => camelCaseKeys(deactivationResult));
};

module.exports.deletePushToken = async ({ token, provider, userId }) => {
    let deleteCount = 0;
    
    const tokenTable = config.get('tables.pushTokenTable');
    if (token) {
        logger('Have token, deleting it: ', token);
        const rdsResult = await rdsConnection.deleteRow(tokenTable, ['push_token', 'user_id'], [token, userId]);
        logger('Push token deletion resulted in:', rdsResult);
        deleteCount = rdsResult.rowCount;
    } else if (provider) {
        const insertionQuery = `select insertion_id from ${tokenTable} where push_provider = $1 and user_id = $2`;
        const fetchedRows = await rdsConnection.selectQuery(insertionQuery, [provider, userId]);
        logger('About to delete token with insertion IDs: ', fetchedRows);
        const deletePromises = fetchedRows.map((row) => rdsConnection.deleteRow(tokenTable, ['insertion_id'], [row['insertion_id']]));
        const deleteResults = await Promise.all(deletePromises);
        logger('Result of deletion: ', deleteResults);
        deleteCount = deleteResults.reduce((val, result) => val + result.rowCount, 0);
    }

    return { deleteCount };
};


module.exports.insertUserMsgPreference = async (userId, preferences) => {
    const insertionObject = { systemWideUserId: userId, ...preferences };
    const objectKeys = Object.keys(insertionObject);

    const insertQuery = `insert into ${config.get('tables.msgPrefsTable')} (${opsUtil.extractQueryClause(objectKeys)}) values %L returning creation_time`;
    
    const resultOfInsertion = await rdsConnection.insertRecords(insertQuery, opsUtil.extractColumnTemplate(objectKeys), [insertionObject]);
    const insertionRows = resultOfInsertion.rows;
    return { insertionTime: moment(insertionRows[0]['creation_time']) };
};

module.exports.updateUserMsgPreference = async (userId, valuesToUpdate) => {
    const updateDef = {
        table: config.get('tables.msgPrefsTable'),
        key: { systemWideUserId: userId },
        value: valuesToUpdate,
        returnClause: 'updated_time'
    };

    const resultOfUpdate = await rdsConnection.updateRecordObject(updateDef);
    return { updatedTime: moment(resultOfUpdate[0]['updated_time']) };
};

module.exports.findNoPushUsers = async (userIds) => {
    const query = `select system_wide_user_id from message_data.user_message_preference where ` +
        `system_wide_user_id in (${opsUtil.extractArrayIndices(userIds)}) and halt_push_messages = true`;
    const fetchedRows = await rdsConnection.selectQuery(query, userIds);

    if (!Array.isArray(fetchedRows) || fetchedRows.length === 0) {
        return [];
    }

    return fetchedRows.map((row) => row['system_wide_user_id']);
};

module.exports.fetchUserMsgPrefs = async (userId) => {
    const query = `select * from ${config.get('tables.msgPrefsTable')} where system_wide_user_id = $1`;
    const fetchedRow = await rdsConnection.selectQuery(query, [userId]);

    return Array.isArray(fetchedRow) && fetchedRow.length > 0 ? camelCaseKeys(fetchedRow[0]) : null;
};
