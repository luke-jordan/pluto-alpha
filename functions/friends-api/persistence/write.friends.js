'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');
const uuid = require('uuid/v4');
const decamelize = require('decamelize');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const friendTable = config.get('tables.friendTable');
const friendRequestTable = config.get('tables.friendRequestTable');
const friendLogTable = config.get('tables.friendLogTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

module.exports.insertFriendRequest = async (requestParams) => {
    const requestId = uuid();
    requestParams.requestId = requestId;
    requestParams.requestStatus = 'PENDING';

    const paramsToInclude = ['requestId', 'requestStatus', 'initiatedUserId', 'targetUserId', 'targetContactDetails', 'requestCode', 'requestType'];
    /* eslint-disable no-confusing-arrow */
    const friendRequest = paramsToInclude.reduce((obj, param) => requestParams[param] ? { ...obj, [param]: requestParams[param] } : { ...obj }, {});
    /* eslint-disable no-confusing-arrow */ 
    const friendReqKeys = Object.keys(friendRequest);
    const friendQueryDef = {
        query: `insert into ${friendRequestTable} (${extractColumnNames(friendReqKeys)}) values %L returning request_id, creation_time`,
        columnTemplate: extractColumnTemplate(friendReqKeys),
        rows: [friendRequest]
    };

    const logId = uuid();
    const logRow = { logId, requestId, logType: 'FRIENDSHIP_REQUESTED', logContext: friendRequest };
    const logKeys = Object.keys(logRow);

    const logInsertDef = {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };

    logger(`Sending out friend request query: ${friendQueryDef} and log query: ${logInsertDef} to rds`);
    const insertionResult = await rdsConnection.largeMultiTableInsert([friendQueryDef, logInsertDef]);
    logger('Result of insertion:', insertionResult);

    const queryRequestId = insertionResult[0][0]['request_id'];
    const queryLogId = insertionResult[1][0]['log_id'];

    return { requestId: queryRequestId, logId: queryLogId };
};

module.exports.insertFriendship = async (initiatedUserId, acceptedUserId) => {
    const relationshipId = uuid();
    const relationshipStatus = 'ACTIVE';

    const friendshipObject = { relationshipId, initiatedUserId, acceptedUserId, relationshipStatus };
    const friendshipKeys = Object.keys(friendshipObject);

    const friendQueryDef = {
        query: `insert into ${friendTable} (${extractColumnNames(friendshipKeys)}) values %L returning relationship_id, creation_time`,
        columnTemplate: extractColumnTemplate(friendshipKeys),
        rows: [friendshipObject]
    };

    const logId = uuid();
    const logRow = { logId, relationshipId, logType: 'FRIENDSHIP_ACCEPTED', logContext: friendshipObject };
    const logKeys = Object.keys(logRow);

    const logInsertDef = {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };

    logger(`Sending out friend request query: ${friendQueryDef} and log query: ${logInsertDef} to rds`);
    const insertionResult = await rdsConnection.largeMultiTableInsert([friendQueryDef, logInsertDef]);
    logger('Result of insertion:', insertionResult);

    const queryRelationshipId = insertionResult[0][0]['relationship_id'];
    const queryLogId = insertionResult[1][0]['log_id'];

    return { relationshipId: queryRelationshipId, logId: queryLogId };
};

module.exports.deactivateFriendship = async (relationshipId) => {
    const updateFriendshipDef = { 
        table: friendTable,
        key: { relationshipId },
        value: { relationshipStatus: 'DEACTIVATED' },
        returnClause: 'updated_time'
    };
      
    const logId = uuid();
    const logRow = { logId, relationshipId, logType: 'FRIENDSHIP_DEACTIVATED', logContext: { relationshipId }};
    const logKeys = Object.keys(logRow);

    const logInsertDef = {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };

    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert([updateFriendshipDef], [logInsertDef]);
    logger('Result of update and insertion:', resultOfOperations);

    const updatedTime = resultOfOperations[0][0]['updated_time'];

    return { updatedTime };
};
