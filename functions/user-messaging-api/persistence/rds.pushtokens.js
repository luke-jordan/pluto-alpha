'use strict';

const logger = require('debug')('jupiter:user-notifications:rds');
const config = require('config');
const camelcase = require('camelcase');

const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
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
