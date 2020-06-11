'use strict';

const logger = require('debug')('jupiter:activity:calculations');
const config = require('config');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

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

    const insertQuery = `insert into ${config.get('tables.factoidTable')} (${columnNames}) values %L returning creation_time`;
    
    logger('Inserting factoid: ', factoid);
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [factoid]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert;
};

// module.exports.updateFactoid = async (updateParams) => {
   
// };

// module.exports.fetchUnreadFactoid = async (systemWideUserId) => {

// };
