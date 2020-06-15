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
const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const factoidTable = config.get('tables.factoidTable');
const previewTable = config.get('tables.previewTable');
/**
 * This functions persists new factoids
 * @param {object} factoid A factoid object containing initial values passed in from the client.
 * @property {string} creatingUserId The system wide user id of the creator of the factoid.
 * @property {string} factoidBody The main factoid text.
 * @property {boolean} active Defines whether the factoid should be active on creation or not.
 * @property {object} responseOptions An object containing response options to be displayed with the factoid to the user.
 */
module.exports.addFactoid = async (factoid) => {
    factoid.factoidId = uuid();
    
    const objectKeys = Object.keys(factoid);
    const columnNames = extractColumnNames(objectKeys);
    const columnTemplate = extractColumnTemplate(objectKeys);

    const insertQuery = `insert into ${factoidTable} (${columnNames}) values %L returning creation_time`;
    
    logger('Inserting factoid: ', factoid);
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [factoid]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

/**
 * This function may be used to update a factoids main text or its active status.
 * @param {object} updateParams 
 * @property {string} factoidId The target factoids identifier.
 * @property {string} body The new factoid text.
 * @property {boolean} active The new factoid active status. 
 */
module.exports.updateFactoid = async (updateParams) => {
    const updateValues = [];
    const setClause = [];

    if (updateParams.body) {
        setClause.push('body = $1');
        updateValues.push(updateParams.body);
    }

    if (Reflect.has(updateParams, 'active')) {
        updateParams.body ? setClause.push('active = $2') : setClause.push('active = $1');
        updateValues.push(updateParams.active);
    }

    updateValues.push(updateParams.factoidId);

    const updateQuery = `update ${factoidTable} set ${setClause.join(', ')} where factoid_id = $${updateValues.length} returning updated_time`;
    logger('Updating factoid with query', updateQuery, 'and values:', updateValues);

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, updateValues);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : null;
};

/**
 * This function fetches an unread factoid for a user.
 * @param {string} systemWideUserId The user for whom the factoid is sought.
 */
module.exports.fetchUnreadFactoid = async (systemWideUserId) => {
    const findQuery = `select factoid_id from ${previewTable} where user_id = $1 and factoid_status = $2`;
    const resultOfSearch = await rdsConnection.selectQuery(findQuery, [systemWideUserId, 'VIEWED']);
    logger('Found viewed factoids:', resultOfSearch)
    const viewedFactoidIds = resultOfSearch.length > 0 ? resultOfSearch.map((result) => result['factoid_id']) : []
    logger('And factoid ids:', viewedFactoidIds)

    const selectQuery = `select title, body from ${factoidTable} where factoid_id not in (${extractArrayIndices(viewedFactoidIds)}) limit 1`;
    logger('Fetching unread factoid with query:', selectQuery)

    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [...viewedFactoidIds]);
    logger('Result of ')
    return resultOfFetch.length > 0 ? camelCaseKeys(resultOfFetch[0]) : [];
};
