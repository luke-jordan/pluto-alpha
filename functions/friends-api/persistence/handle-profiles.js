'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const friendTable = config.get('tables.friendTable');
const friendRequestTable = config.get('tables.friendRequestTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

module.exports.insertFriendRequest = async (requestParams) => {
    requestParams.requestId = uuid();

    const paramsToInclude = ['requestId', 'initiatedUserId', 'targetUserId', 'targetContactDetails', 'requestType'];
    /* eslint-disable no-confusing-arrow */
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
    const relationshipStatus = 'ACTIVE';

    const friendshipObject = { relationshipId, initiatedUserId, acceptedUserId, relationshipStatus };

    const objectKeys = Object.keys(friendshipObject);
    const columnNames = extractColumnNames(objectKeys);
    const columnTemplate = extractColumnTemplate(objectKeys);

    const insertQuery = `insert into ${friendTable} (${columnNames}) values %L returning relationship_id`;
    logger(`Sending insertion query: ${insertQuery} with column template: ${columnTemplate}`);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [friendshipObject]);
    logger('Result of insertion: ', resultOfInsert);

    return typeof resultOfInsert === 'object' && Array.isArray(resultOfInsert.rows) 
        ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

module.exports.deactivateFriendship = async (relationshipId) => {
    const updateQuery = `update ${friendTable} set relationship_status = $1 where relationship_id = $2 returning relationship_id`;
    const updateResult = await rdsConnection.updateRecord(updateQuery, ['DEACTIVATED', relationshipId]);
    logger('Result of straight update boosts: ', updateResult);

    return typeof updateResult === 'object' && Array.isArray(updateResult.rows) 
        ? camelCaseKeys(updateResult.rows[0]) : null;
};
