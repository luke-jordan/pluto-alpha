'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const friendsTable = config.get('tables.friendsTable');
const friendRequestTable = config.get('tables.friendRequestTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

module.exports.insertFriendRequest = async (requestParams) => {
    requestParams.requestId = uuid();

    const paramsToInclude = ['requestId', 'initiatedUserId', 'targetUserId', 'targetContactDetails', 'requestType'];
    /* eslint-disable no-confusing-arrow */ // TODO: refactor
    const friendRequest = paramsToInclude.reduce((obj, param) => requestParams[param] ? { ...obj, [param]: requestParams[param] } : { ...obj }, {});
    /* eslint-disable no-confusing-arrow */ 
    
    const objectKeys = Object.keys(friendRequest);
    const columnTemplate = extractColumnTemplate(objectKeys);

    const insertQuery = `insert into ${friendRequestTable} (${extractColumnNames(objectKeys)}) values %L returning request_id`;
    logger(`Sending insertion query: ${insertQuery} with column template: ${columnTemplate}`);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [friendRequest]);
    logger('Result of insertion: ', resultOfInsert);

    return typeof resultOfInsert === 'object' && Array.isArray(resultOfInsert.rows) 
        ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

module.exports.insertFriendship = async (initiatedUserId, acceptedUserId) => {
    const relationshipId = uuid();

    const friendshipObject = { relationshipId, initiatedUserId, acceptedUserId };

    const objectKeys = Object.keys(friendshipObject);
    const columnNames = extractColumnNames(objectKeys);
    const columnTemplate = extractColumnTemplate(objectKeys);

    const insertQuery = `insert into ${friendsTable} (${columnNames}) values %L returning relationship_id`;
    logger(`Sending insertion query: ${insertQuery} with column template: ${columnTemplate}`);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [friendshipObject]);
    logger('Result of insertion: ', resultOfInsert);

    return typeof resultOfInsert === 'object' && Array.isArray(resultOfInsert.rows) 
        ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};
