'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');
const uuid = require('uuid/v4');

const camelCaseKeys = require('camelcase-keys');
const decamelize = require('decamelize');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const friendTable = config.get('tables.friendTable');
const friendReqTable = config.get('tables.friendRequestTable');
const friendLogTable = config.get('tables.friendLogTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

/**
 * This function persists a new friend requests, initialising its request status to PENDING
 * @param {object} requestParams
 * @property {string} initiatedUserId Required. The system id of the user requesting the friendship.
 * @property {string} targetUserId The system id of the requested friend. Optional in the presence targetContactDetails. But ultimately required and can be updated later.
 * @property {string} targetContactDetails Optional if targetUserId is provided. The target users contact detail. 
 * @property {string} requestCode Required in the absence of targetUserId. This will be used to identify the friend request when the targetUserId is updated later.
 * @property {string} requestType Optional. A future property.
 */
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
        query: `insert into ${friendReqTable} (${extractColumnNames(friendReqKeys)}) values %L returning request_id, creation_time`,
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

/**
 * This function connects a target user id to a friend request created without one. It also releases the request code so it may be 
 * used by future  friendship requests.
 * @param {string} targetUserId The system id of the target user.
 * @param {string} requestCode The unique request code associated with the friend request.
 */
module.exports.connectUserToFriendRequest = async (targetUserId, requestCode) => {
    const updateQuery = `update ${friendReqTable} set target_user_id = $1, request_code = null where request_code = $2 ` +
        `returning request_id, updated_time`;
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [targetUserId, requestCode]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? resultOfUpdate.rows.map((row) => camelCaseKeys(row)) : [];
};

/**
 * This function activates and inserts a new friendship. It also updates the associated friend request to ACCEPTED.
 * @param {string} requestId The request id associated with the friend request being accepted.
 * @param {string} initiatedUserId The system id of the user who requested the friendship.
 * @param {string} acceptedUserId The system id of the user who accepted the friendship.
 */
module.exports.insertFriendship = async (requestId, initiatedUserId, acceptedUserId) => {
    const relationshipId = uuid();
    const relationshipStatus = 'ACTIVE';

    const friendshipObject = { relationshipId, initiatedUserId, acceptedUserId, relationshipStatus };
    const friendshipKeys = Object.keys(friendshipObject);

    const friendshipInsertDef = {
        query: `insert into ${friendTable} (${extractColumnNames(friendshipKeys)}) values %L returning relationship_id, creation_time`,
        columnTemplate: extractColumnTemplate(friendshipKeys),
        rows: [friendshipObject]
    };

    const friendReqUpdateDef = {
        table: friendTable,
        key: { requestId },
        value: { requestStatus: 'ACCEPTED' },
        returnClause: 'updated_time'
    };

    const logId = uuid();
    const logRow = { logId, relationshipId, logType: 'FRIENDSHIP_ACCEPTED', logContext: friendshipObject };
    const logKeys = Object.keys(logRow);

    const logInsertDef = {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };

    logger(`Persisting: ${friendshipInsertDef} and ${logInsertDef} Updating: ${friendReqUpdateDef}`);
    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert([friendReqUpdateDef], [friendshipInsertDef, logInsertDef]);
    logger('Result of update and insertion:', resultOfOperations);

    const updatedTime = resultOfOperations[0][0]['updated_time'];
    const queryRelationshipId = resultOfOperations[1][0]['relationship_id'];
    const queryLogId = resultOfOperations[1][1]['log_id'];

    return { updatedTime, relationshipId: queryRelationshipId, logId: queryLogId };
};

/**
 * This function deactivates a friendship. It executed with much sadness.
 * @param {string} relationshipId The friendships relationship id.
 */
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
