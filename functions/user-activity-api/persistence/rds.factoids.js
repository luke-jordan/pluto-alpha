'use strict';

const logger = require('debug')('jupiter:activity:calculations');
const config = require('config');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');
const camelCaseKeys = require('camelcase-keys');
const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

const factoidTable = config.get('tables.factoidTable');
const factoidJoinTable = config.get('tables.factoidJoinTable');
const factoidLogTable = config.get('tables.factoidLogTable');

const transformFactoid = (factoid) => ({
    factoidId: factoid.factoidId || factoid.factoidDataFactoidFactoidId,
    title: factoid.title,
    text: factoid.body,
    fetchCount: factoid.fetchCount || 0,
    viewCount: factoid.viewCount || 0,
    factoidStatus: factoid.factoidStatus || 'UNCREATED',
    factoidPriority: factoid.factoidPriority
});

const extractColumnDetails = (object) => {
    const objectKeys = Object.keys(object);
    return [extractColumnNames(objectKeys), extractColumnTemplate(objectKeys)];
};

/**
 * This functions persists new factoids
 * @param {object} factoid A factoid object containing initial values passed in from the client.
 * @property {string}  creatingUserId The system wide user id of the creator of the factoid.
 * @property {string}  factoidBody The main factoid text.
 * @property {boolean} active Defines whether the factoid should be active on creation or not.
 * @property {object}  responseOptions An object containing response options to be displayed with the factoid to the user.
 */
module.exports.addFactoid = async (factoid) => {
    factoid.factoidId = uuid();

    const [columnNames, columnTemplate] = extractColumnDetails(factoid);
    const insertQuery = `insert into ${factoidTable} (${columnNames}) values %L returning creation_time`;
    
    logger('Inserting factoid: ', factoid);
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [factoid]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

// Creates a factoid reference in the user-factoid join table.
module.exports.createFactoidUserJoin = async (factoidId, userId) => {
    const factoidRefObject = { userId, factoidId, factoidStatus: 'CREATED' };

    const [columnNames, columnTemplate] = extractColumnDetails(factoidRefObject);
    const insertQuery = `insert into ${factoidJoinTable} (${columnNames}) values %L returning creation_time`;
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [factoidRefObject]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

// Fetches a factoid reference from the user-factoid join table created above.
module.exports.fetchFactoidUserStatuses = async (factoidIds, userId) => {
    const selectQuery = `select * from ${factoidJoinTable} where user_id = $1 and factoid_id in (${opsUtil.extractArrayIndices(factoidIds, 2)})`;
    logger('Fetching factoids with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [userId, ...factoidIds]);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => camelCaseKeys(result)) : [];
};

// Increments a factoids view count (by updating the view count in the factoid reference in the user-factoid join table)
module.exports.incrementCount = async (factoidId, userId, status) => {
    if (!['FETCHED', 'VIEWED'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
    }

    const updateColumn = status === 'FETCHED' ? 'fetch_count' : 'view_count';
    const updateQuery = `UPDATE ${factoidJoinTable} SET ${updateColumn} = ${updateColumn} + 1 WHERE factoid_id = $1 ` +
        `and user_id = $2 returning ${updateColumn}, updated_time`;

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [factoidId, userId]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : [];
};

// Updates a factoids status, typically to VIEWED.
module.exports.updateFactoidStatus = async (factoidId, userId, status) => {
    const updateQuery = `UPDATE ${factoidJoinTable} SET factoid_status = $1 WHERE factoid_id = $2 ` +
        `and user_id = $3 returning updated_time`;

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [status, factoidId, userId]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : [];
};

/**
 * This function fetches unread factoids for a user.
 * @param {string} systemWideUserId The user for whom the factoids are sought.
 */
module.exports.fetchUncreatedFactoids = async (systemWideUserId) => {
    const selectQuery = `select * from ${factoidTable} where active = $1 factoid_id not in ` +
        `(select factoid_id from ${factoidJoinTable} where user_id = $2 and factoid_status = $3)`;
    logger('Fetching unread factoids with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [true, systemWideUserId, 'VIEWED']);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => transformFactoid(camelCaseKeys(result))) : [];
};

/**
 * This function fetches viewed factoids for a user.
 * @param {string} systemWideUserId The user for whom the factoids are sought.
 */
module.exports.fetchCreatedFactoids = async (systemWideUserId) => {
    const selectQuery = `select * from ${factoidJoinTable} inner join ${factoidTable} where user_id = $1 and active = $2`;
    logger('Fetching unread factoids with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId, true]);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => transformFactoid(camelCaseKeys(result))) : [];
};

/**
 * This function may be used to update a factoids main text, its active status, or its priority.
 * @param {object} updateParameters 
 * @property {string}  factoidId The target factoids identifier.
 * @property {string}  body The new factoid text.
 * @property {boolean} active The new factoid active status. 
 * @property {number}  priority The factoids priority number.
 */
module.exports.updateFactoid = async (updateParameters) => {
    const factoidId = updateParameters.factoidId;
    Reflect.deleteProperty(updateParameters, 'factoidId');

    const updateDef = { 
        key: { factoidId },
        value: updateParameters,
        table: factoidTable,
        returnClause: 'updated_time'
    };

    const resultOfUpdate = await rdsConnection.updateRecordObject(updateDef);
    logger('Result of update: ', resultOfUpdate);

    return Array.isArray(resultOfUpdate) && resultOfUpdate.length > 0
        ? camelCaseKeys(resultOfUpdate[0]) : null;
};

/**
 * This function is used to log factoid events, typically called when a factoid is viewed.
 * @param {object} logObject An object containing the properties to be persisted (listed below)
 * @property {string} userId The user who has interacted with the factoid.
 * @property {string} factoidId The factoid that has been interacted with.
 * @property {string} logType A string describing the user action/type of interaction, e.g FACTOID_VIEWED.
 * @property {object} logContext An object containing additional properties to be persisted, pass empty object if none. 
 */
module.exports.insertFactoidLog = async (logObject) => {    
    const logId = uuid();
    const logRow = { logId, ...logObject };

    const insertQuery = `insert into ${factoidLogTable} (log_id, user_id, factoid_id, log_type, log_context) values %L returning log_id`;
    const columnTemplate = '${logId}, ${userId}, ${factoidId}, ${logType}, ${logContext}';
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [logRow]);
    logger('Result of inserting log: ', resultOfInsert);

    return resultOfInsert['rows'][0]['log_id'];
};
