'use strict';

const logger = require('debug')('jupiter:friends:dynamo');
const config = require('config');
const uuid = require('uuid/v4');

const opsUtil = require('ops-util-common');

const camelCaseKeys = require('camelcase-keys');
const decamelize = require('decamelize');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const friendshipTable = config.get('tables.friendshipTable');
const friendReqTable = config.get('tables.friendRequestTable');
const friendLogTable = config.get('tables.friendLogTable');
const userIdTable = config.get('tables.friendUserIdTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

// do this at the moment until start building in replication in, e.g., account open
const checkForAndInsertUserIds = async ({ initiatedUserId, targetUserId }) => {
    const userIds = targetUserId ? [initiatedUserId, targetUserId] : [initiatedUserId];
    const findQuery = `select user_id from ${userIdTable} where user_id in (${opsUtil.extractArrayIndices(userIds)})`;
    const presentRows = await rdsConnection.selectQuery(findQuery, userIds);

    const foundInitiatedUserId = presentRows.map((row) => row['user_id']).some((userId) => userId === initiatedUserId);
    const foundTargetUserId = !targetUserId || presentRows.map((row) => row['user_id']).some((userId) => userId === targetUserId);

    if (foundInitiatedUserId && foundTargetUserId) {
        return;
    }

    // could include this in the multi-table insert below, but that would cause a lot of complexity in insertFriendRequest, so
    // rather have the second query here (and in future integrate this with account opening, then deprecate)
    const insertQuery = `insert into ${userIdTable} (user_id) values %L returning creation_time`;
    const rows = [];
    if (!foundInitiatedUserId) {
        rows.push({ userId: initiatedUserId });
    }

    if (!foundTargetUserId) {
        rows.push({ userId: targetUserId});
    }

    const resultOfInsertion = await rdsConnection.insertRecords(insertQuery, '${userId}', rows);
    logger('Inserted user Ids: ', resultOfInsertion);
};

const checkForExistingFriendRequest = async (friendRequest) => {
    const { initiatedUserId, targetUserId, targetContactDetails } = friendRequest;

    let findQuery = null;
    let queryValues = [];

    if (targetUserId) {
        findQuery = `select * from ${friendReqTable} where initiated_user_id = $1 and target_user_id = $2`;
        queryValues = [initiatedUserId, targetUserId];
    } else {
        findQuery = `select * from ${friendReqTable} where initiated_user_id = $1 and target_contact_details = $2`;
        queryValues = [initiatedUserId, targetContactDetails];
    }

    const existingFriendRequest = await rdsConnection.selectQuery(findQuery, queryValues);
    
    return existingFriendRequest.length > 0 ? camelCaseKeys(existingFriendRequest[0]) : null;
};

/**
 * This function persists a new friend requests, initialising its request status to PENDING
 * @param {object} friendRequest
 * @property {String} initiatedUserId Required. The system id of the user requesting the friendship.
 * @property {String} targetUserId The system id of the requested friend. Optional in the presence targetContactDetails. But ultimately required and can be updated later.
 * @property {String} targetContactDetails The target users contact detail. Optional if targetUserId is provided.
 * @property {String} requestCode Required in the absence of targetUserId. This will be used to identify the friend request when the targetUserId is updated later.
 * @property {String} requestType Used in managing shared items in a relationship. Valid values are CREATE and UPDATE.
 * @property {Array} requestedShareItems Specifies what the initiating user wants to share.
 */
module.exports.insertFriendRequest = async (friendRequest) => {
    const existingFriendRequest = await checkForExistingFriendRequest(friendRequest);
    if (existingFriendRequest) {
        return existingFriendRequest;
    }
    // do this for now
    await checkForAndInsertUserIds(friendRequest);
    
    const requestId = uuid();
    
    friendRequest.requestId = requestId;
    friendRequest.requestStatus = 'PENDING';

    const friendReqKeys = Object.keys(friendRequest);
    const friendQueryDef = {
        query: `insert into ${friendReqTable} (${extractColumnNames(friendReqKeys)}) values %L returning request_id, creation_time`,
        columnTemplate: extractColumnTemplate(friendReqKeys),
        rows: [friendRequest]
    };

    const logId = uuid();
    const logRow = { logId, requestId, logType: 'FRIENDSHIP_REQUESTED', logContext: friendRequest };
    const logKeys = Object.keys(logRow);

    const insertLogDef = {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };

    logger(`Persisting friend request with params: ${friendQueryDef} and persisting logs: ${insertLogDef}`);
    const insertionResult = await rdsConnection.largeMultiTableInsert([friendQueryDef, insertLogDef]);
    logger('Result of insertion:', insertionResult);

    const queryRequestId = insertionResult[0][0]['request_id'];
    const creationTime = insertionResult[0][0]['creation_time'];
    const queryLogId = insertionResult[1][0]['log_id'];

    logger(`Request ids from persistence: ${queryRequestId} and ${queryLogId}`);

    friendRequest.creationTime = creationTime;
    return friendRequest;
};

/**
 * This function connects a target user id to a friend request created without one. It also releases the request code so it may be 
 * used by future friendship requests.
 * @param {String} targetUserId The system id of the target user.
 * @param {String} requestCode The unique request code associated with the friend request.
 */
module.exports.connectUserToFriendRequest = async (targetUserId, requestCode) => {
    const updateQuery = `update ${friendReqTable} set target_user_id = $1, request_code = null where request_code = $2 ` +
        `returning request_id, updated_time`;
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [targetUserId, requestCode]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? resultOfUpdate.rows.map((row) => camelCaseKeys(row)) : [];
};

const createLogDef = ({ requestId, relationshipId, logType, logContext }) => {
    const logRow = { logId: uuid(), logType, logContext };
    if (requestId) {
        logRow.requestId = requestId;
    }
    if (relationshipId) {
        logRow.relationshipId = relationshipId;
    }
    const logKeys = Object.keys(logRow);
    return {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };
};

const transformUpdateResult = (resultOfOperations) => {
    const updatedTime = resultOfOperations[0][0]['updated_time'];
    const queryLogId = resultOfOperations[1][0]['log_id'];

    return { updatedTime, logId: queryLogId };
};

/** todo update docs here
 * This function updates a friend requests status to IGNOREED and logs the event.
 * @param {String} targetUserId The system id of the ignoring user.
 * @param {String} initiatedUserId The system id of the ignored user.
 */
module.exports.ignoreFriendshipRequest = async (requestId, instructedByUserId) => {
    // todo : and status = PENDING (so we do not retrospectively wipe previously accepted / cancelled ones)
    const updateFriendReqDef = {
        table: friendReqTable,
        key: { requestId },
        value: { requestStatus: 'IGNORED' },
        returnClause: 'updated_time'
    };

    const insertLogDef = createLogDef({ requestId, logType: 'FRIENDSHIP_IGNORED', logContext: { instructedByUserId }});

    logger(`Updating: ${JSON.stringify(updateFriendReqDef)} Persisting: ${JSON.stringify(insertLogDef)}`);
    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert([updateFriendReqDef], [insertLogDef]);
    logger('Result of update and insertion:', resultOfOperations);
    return transformUpdateResult(resultOfOperations);
};

/**
 * This one just cancels, given a request ID
 */
module.exports.cancelFriendshipRequest = async (requestId, performedByUserId) => {
    const updateFriendReqDef = {
        table: friendReqTable,
        key: { requestId },
        value: { requestStatus: 'CANCELLED' },
        returnClause: 'updated_time'
    };

    const logDef = createLogDef({ requestId, logType: 'REQUEST_CANCELLED', logContext: { performedByUserId }});
    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert([updateFriendReqDef], [logDef]);
    return transformUpdateResult(resultOfOperations);
};

const checkForExistingFriendship = async (initiatedUserId, acceptedUserId) => {
    const query = `select relationship_id from ${friendshipTable} where initiated_user_id = $1 and accepted_user_id = $2`; 
    const [firstResult, secondResult] = await Promise.all([
        rdsConnection.selectQuery(query, [initiatedUserId, acceptedUserId]),
        rdsConnection.selectQuery(query, [acceptedUserId, initiatedUserId])
    ]);

    const queryResult = [...firstResult, ...secondResult];
    logger('Found existing friendship:', queryResult);

    return query.length > 0 ? camelCaseKeys(queryResult[0]) : null;
};

/**
 * This function activates and persists a new friendship. It also updates the associated friend request to ACCEPTED.
 * @param {String} requestId The request id associated with the friend request being accepted.
 * @param {String} initiatedUserId The system id of the user who requested the friendship.
 * @param {String} acceptedUserId The system id of the user who accepted the friendship.
 * @param {Array} shareItems An array describing what the users in a friendship have agreed to share. Valid elements include 'ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', and 'BALANCE'
 */
module.exports.insertFriendship = async (requestId, initiatedUserId, acceptedUserId, shareItems) => {
    const relationshipId = uuid();

    const relationshipStatus = 'ACTIVE';

    const friendshipObject = { relationshipId, initiatedUserId, acceptedUserId, relationshipStatus, shareItems };
    const friendshipKeys = Object.keys(friendshipObject);


    const updateDefs = [];

    let persistedRelationshipId = '';
    const existingFriendship = await checkForExistingFriendship(initiatedUserId, acceptedUserId);
    logger('Found existing friendship:', existingFriendship);
    
    // if the friendship does not exist, insert it first, before moving on to the other wiring
    if (!existingFriendship) {
        const insertQuery = `insert into ${friendshipTable} (${extractColumnNames(friendshipKeys)}) values %L returning relationship_id, creation_time`;
        const insertResult = await rdsConnection.insertRecords(insertQuery, extractColumnTemplate(friendshipKeys), [friendshipObject]);
        persistedRelationshipId = insertResult[0]['relationship_id'];
    }

    // otherwise, put it into the update
    if (existingFriendship) {
        const friendshipUpdateDef = {
            table: friendshipTable,
            key: { relationshipId: existingFriendship.relationshipId },
            value: { relationshipStatus: 'ACTIVE' },
            returnClause: 'updated_time'
        };
        updateDefs.push(friendshipUpdateDef);
        persistedRelationshipId = existingFriendship.relationshipId;
    } 

    // need to make sure friendship is in before doing this, so foreign key works (could jam into TX but more than worth at present)
    const updateFriendReqDef = {
        table: friendReqTable,
        key: { requestId },
        value: { requestStatus: 'ACCEPTED', referenceFriendshipId: relationshipId },
        returnClause: 'updated_time'
    };
    updateDefs.push(updateFriendReqDef);
    logger('Updating friend request via: ', updateFriendReqDef);

    const insertLogDef = createLogDef({ requestId, relationshipId, logType: 'FRIENDSHIP_ACCEPTED', logContext: friendshipObject });

    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert(updateDefs, [insertLogDef]);
    logger('Result of operations: ', resultOfOperations);

    const queryLogId = resultOfOperations[1][0]['log_id'];

    return { relationshipId: persistedRelationshipId, logId: queryLogId };
};

/**
 * This function deactivates a friendship. It is executed with much sadness.
 * @param {String} relationshipId The friendships relationship id.
 */
module.exports.deactivateFriendship = async (relationshipId) => {
    const updateFriendshipDef = { 
        table: friendshipTable,
        key: { relationshipId },
        value: { relationshipStatus: 'DEACTIVATED' },
        returnClause: 'updated_time'
    };
      
    const logId = uuid();
    const logRow = { logId, relationshipId, logType: 'FRIENDSHIP_DEACTIVATED', logContext: { relationshipId }};
    const logKeys = Object.keys(logRow);

    const insertLogDef = {
        query: `insert into ${friendLogTable} (${extractColumnNames(logKeys)}) values %L returning log_id, creation_time`,
        columnTemplate: extractColumnTemplate(logKeys),
        rows: [logRow]
    };

    logger(`Updating friendship with ${updateFriendshipDef} and persisting logs ${insertLogDef}`);
    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert([updateFriendshipDef], [insertLogDef]);
    logger('Result of update and insertion:', resultOfOperations);

    const updatedTime = resultOfOperations[0][0]['updated_time'];
    const queryLogId = resultOfOperations[1][0]['log_id'];

    return { updatedTime, logId: queryLogId };
};
