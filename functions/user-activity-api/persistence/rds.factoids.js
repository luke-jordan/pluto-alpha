'use strict';

const logger = require('debug')('jupiter:activity:calculations');
const config = require('config');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

const factoidTable = config.get('tables.factoidTable');
const factoidJoinTable = config.get('tables.factoidJoinTable');

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

/**
 * This function fetches unread factoids for a user.
 * @param {string} systemWideUserId The user for whom the factoids are sought.
 */
module.exports.fetchUnviewedFactoids = async (systemWideUserId) => {
    const selectQuery = `select * from ${factoidTable} where factoid_id not in (select factoid_id from ${factoidJoinTable} where user_id = $1)`;
    logger('Fetching unread factoids with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId]);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => camelCaseKeys(result)) : [];
};

/**
 * This function fetches viewed factoids for a user.
 * @param {string} systemWideUserId The user for whom the factoids are sought.
 */
module.exports.fetchViewedFactoids = async (systemWideUserId) => {
    const selectQuery = `select * from ${factoidTable} where factoid_id in (select factoid_id from ${factoidJoinTable} where user_id = $1)`;
    logger('Fetching unread factoids with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId]);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => camelCaseKeys(result)) : [];
    // todo: return user join table output
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
 * This function updates a factoid to viewed by a specified user.
 * @param {string} systemWideUserId The system wide identifier of the user who has viewed the factoid.
 * @param {string} factoidId The identifier of the factoid that has been viewed.
 */
module.exports.updateFactoidToViewed = async (systemWideUserId, factoidId) => {
    const userFactoidObject = { userId: systemWideUserId, factoidId, factoidStatus: 'VIEWED' };
    const [columnNames, columnTemplate] = extractColumnDetails(userFactoidObject);
    const insertQuery = `insert into ${factoidJoinTable} (${columnNames}) values %L returning creation_time`;
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [userFactoidObject]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};
