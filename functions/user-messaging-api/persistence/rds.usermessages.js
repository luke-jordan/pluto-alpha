'use strict';

const logger = require('debug')('jupiter:message:picker-rds');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const userMessageTable = config.get('tables.userMessagesTable');

// helper for a common pattern
const executeQueryAndGetIds = async (query, values, idColumn = 'destination_user_id') => {
    const rows = await rdsConnection.selectQuery(query, values);
    return rows.map((row) => row[idColumn]);
};

// ////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// USER MESSAGE INSERTION ///////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////

/**
 * This function inserts user messages in bulk. It accepts an array of user message objects and an array of a user message object's keys.
 * @param {array} rows An array of persistable user message rows.
 * @param {array} objectKeys An array of a rows object keys.
 */ 
module.exports.insertUserMessages = async (rows, objectKeys) => {
    const messageQueryDef = {
        query: `insert into ${userMessageTable} (${opsUtil.extractQueryClause(objectKeys)}) values %L returning message_id, creation_time`,
        columnTemplate: opsUtil.extractColumnTemplate(objectKeys),
        rows: rows
    };
    // logger('Created insertion query:', messageQueryDef);

    const insertionResult = await rdsConnection.largeMultiTableInsert([messageQueryDef]);
    // logger('User messages insertion resulted in:', insertionResult);
    const insertionRows = insertionResult[0]; // as multi table returns array of query
    return insertionRows.map((insertResult) => camelCaseKeys(insertResult));
};

/**
 * This function accepts an existing audience ID and returns the corresponding user IDs.
 * @param {string} audienceId The audience in question
 */
module.exports.getUserIdsForAudience = async (audienceId) => {
    logger('Selecting accounts from audience: ', audienceId);
    
    const selectionQuery = `select account_id, owner_user_id from ${config.get('tables.accountLedger')} where account_id in ` +
        `(select account_id from ${config.get('tables.audienceJoinTable')} where audience_id = $1 and active = $2)`;

    logger('Assembled audience ID selection clause: ', selectionQuery);
    return executeQueryAndGetIds(selectionQuery, [audienceId, true], 'owner_user_id');
};

/**
 * This function accepts an instruction ID and returns a message instruction from the database.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.getMessageInstruction = async (instructionId) => {
    const query = `select * from ${config.get('tables.messageInstructionTable')} where instruction_id = $1`;
    const value = [instructionId];

    const response = await rdsConnection.selectQuery(query, value);
    // logger('Got this back from user message instruction extraction:', response);

    return camelCaseKeys(response[0]);
};

/**
 * Used for obtaining messages during regular processing or at user start
 */
module.exports.getInstructionsByType = async (presentationType, audienceTypes, processedStatuses) => {
    let query = `select * from ${config.get('tables.messageInstructionTable')} where presentation_type = $1 ` + 
        `and active = true and end_time > current_timestamp`;
    let values = [presentationType];

    let paramStartIndex = 2;
    if (Array.isArray(audienceTypes) && audienceTypes.length > 0) {
        query = `${query} and audience_type in (${opsUtil.extractArrayIndices(audienceTypes, paramStartIndex)})`;
        values = values.concat(audienceTypes);
        paramStartIndex += audienceTypes.length;
    }

    if (Array.isArray(processedStatuses) && processedStatuses.length > 0) {
        query = `${query} and processed_status in (${opsUtil.extractArrayIndices(processedStatuses, paramStartIndex)})`;
        values = values.concat(processedStatuses);
        paramStartIndex += processedStatuses.length;
    }

    logger(`Finding message instructions using query: ${query}, and values: ${JSON.stringify(values)}`);
    const response = await rdsConnection.selectQuery(query, values);
    logger('Got this back from user message instruction extraction:', response);

    return response.map((instruction) => camelCaseKeys(instruction));
};

/**
 * This will find those user IDs in the list that are not disqualified by the recurrence parameters. Note: ugly as hell.
 */
module.exports.filterUserIdsForRecurrence = async (userIds, { instructionId, recurrenceParameters }) => {
    // in time, some of these will be optional, for now just use each of them
    // also in time, do this in a single join query reusing most of the components above (though not sure how sampling will work)
    // on the other hand, sampling on recurrence becomes difficult to handle generally (different sample all the time?), so
    // will want to think through that (todo : JIRA issue)
    
    const messageTable = config.get('tables.userMessagesTable');
    logger('Filtering recurrence for ID: ', instructionId, 'on parameters: ', recurrenceParameters);

    // min days, means exclude owner user IDs where this recurrence occurred within that period, so we find those that have a 
    // message which is more recent than that and related to this instruction; see note below re inclusion of user_ids, for now
    // note : could have used postgres current_timestamp - interval but it does not play well with parameters, hence
    const minIntervalQuery = `select distinct(destination_user_id) from ${messageTable} where instruction_id = $1 and ` +
        `creation_time > $2`;
    const durationClause = moment().subtract(recurrenceParameters.minIntervalDays, 'days').format();
    const intervalPromise = executeQueryAndGetIds(minIntervalQuery, [instructionId, durationClause]);

    // here consciously allowing this to be everything -- could do an 'in' clause with user IDs but very complex and probably 
    // has little gain, esp as might create enourmous query when have 100k + users and evaluating a generic recurrence
    const minQueueQuery = `select destination_user_id from ${messageTable} where processed_status = $1 and end_time > current_timestamp ` + 
        `group by destination_user_id having count(*) > $2`;
    const queueSizePromise = executeQueryAndGetIds(minQueueQuery, ['READY_FOR_SENDING', recurrenceParameters.maxInQueue]);

    const [usersWithinInterval, usersWithQueue] = await Promise.all([intervalPromise, queueSizePromise]);
    // this will mean redundancy but removing overlap would serve little purpose, hence leaving it
    const idsToFilter = usersWithinInterval.concat(usersWithQueue);
    logger('Removing these IDs for interval: ', usersWithinInterval);
    logger('Removing these IDs for queue: ', usersWithQueue);

    return userIds.filter((id) => !idsToFilter.includes(id));
};

const assembleUpdateParams = (instructionId, value) => ({
    table: config.get('tables.messageInstructionTable'),
    key: { instructionId },
    value,
    returnClause: 'updated_time'
});

module.exports.updateInstructionState = async (instructionId, newProcessedStatus) => {
    const currentTime = moment().format();
    const value = { processedStatus: newProcessedStatus, lastProcessedTime: currentTime };
    const response = await rdsConnection.updateRecordObject(assembleUpdateParams(instructionId, value));
    logger('Result of message instruction update:', response);

    return response.length > 0 ? response.map((updateResult) => camelCaseKeys(updateResult))[0] : null;
};

module.exports.updateInstructionProcessedTime = async (instructionId, lastProcessedTime) => {
    const response = await rdsConnection.updateRecordObject(assembleUpdateParams(instructionId, { lastProcessedTime }));
    logger('Response of updating processed time: ', response);
    return response.length > 0 ? response.map((updateResult) => camelCaseKeys(updateResult))[0] : null;
};

module.exports.deactivateInstruction = async (instructionId) => {
    const currentTime = moment().format();
    const value = { active: false, lastProcessedTime: currentTime };
    const response = await rdsConnection.updateRecordObject(assembleUpdateParams(instructionId, value));
    logger('Result of message instruction deactivation:', response);

    return response.map((updateResult) => camelCaseKeys(updateResult));
};

// ////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// USER MESSAGE FETCHING ///////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////

const transformMsg = (msgRawFromRds) => {
    const msgObject = camelCaseKeys(msgRawFromRds);
    // convert timestamps to moments
    msgObject.creationTime = moment(msgObject.creationTime);
    msgObject.startTime = moment(msgObject.startTime);
    msgObject.endTime = moment(msgObject.endTime);
    // remove some unnecessary objects
    const keysToRemove = ['deliveriesDone', 'deliveriesMax', 'flags', 'instructionId', 'processedStatus', 'updatedTime'];
    return Object.keys(msgObject).filter((key) => keysToRemove.indexOf(key) < 0).
        reduce((obj, key) => ({ ...obj, [key]: msgObject[key] }), {});
};

module.exports.getNextMessage = async (destinationUserId, messageTypes) => {
    const values = [destinationUserId, 'READY_FOR_SENDING', ...messageTypes];
    const typeIndices = opsUtil.extractArrayIndices(messageTypes, 3);

    const query = `select * from ${userMessageTable} where destination_user_id = $1 and processed_status = $2 ` + 
        `and end_time > current_timestamp and start_time < current_timestamp and deliveries_done < deliveries_max ` +
        `and display ->> 'type' in (${typeIndices})`;
    
    const result = await rdsConnection.selectQuery(query, values);
    logger('Retrieved next message from RDS: ', result);
    return result.map((msg) => transformMsg(msg));
};

module.exports.fetchUserHistoricalMessages = async (destinationUserId, messageTypes) => {
    const values = [destinationUserId, ...messageTypes];
    const typeIndices = opsUtil.extractArrayIndices(messageTypes, 2);

    const query = `select * from ${userMessageTable} where destination_user_id = $1 and display ->> 'type' in (${typeIndices})`;
    
    const result = await rdsConnection.selectQuery(query, values);
    logger('Retrieved past user messages from RDS: ', result);
    return result.map((msg) => transformMsg(msg));
};

module.exports.getPendingOutboundMessages = async (messageType) => {
    const query = `select * from ${userMessageTable} where processed_status = $1 and end_time > current_timestamp and ` +
        `start_time < current_timestamp and deliveries_done < deliveries_max and display ->> 'type' = $2`;
    const values = ['READY_FOR_SENDING', messageType];
    const resultOfQuery = await rdsConnection.selectQuery(query, values);
    return resultOfQuery.map((msg) => transformMsg(msg));
};

module.exports.getInstructionMessage = async (destinationUserId, instructionId) => {
    const query = `select * from ${userMessageTable} where destination_user_id = $1 and instruction_id = $2`;
    const result = await rdsConnection.selectQuery(query, [destinationUserId, instructionId]);
    return result.map((msg) => transformMsg(msg));
};

// ////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// MESSAGE STATUS HANDLING //////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////

/**
 * Updates a message
 */
module.exports.updateUserMessage = async (messageId, updateValues) => {
    logger('Update message with ID: ', messageId, 'to: ', updateValues);
    const updateDef = {
        table: userMessageTable,
        key: { messageId },
        value: updateValues,
        returnClause: 'message_id, updated_time' 
    };

    const resultOfUpdate = await rdsConnection.multiTableUpdateAndInsert([updateDef], []);
    logger('Update result from RDS: ', resultOfUpdate);

    const resultToReturn = camelCaseKeys(resultOfUpdate[0]);
    resultToReturn.updatedTime = moment(resultToReturn.updatedTime);

    return resultToReturn;
};

/* Batch updates status */
module.exports.bulkUpdateStatus = async (messageIds, newStatus) => {
    logger('Updating messageIds : ', messageIds);
    const idIndices = messageIds.map((_, idx) => `$${idx + 2}`).join(', ');
    const updateQuery = `update ${userMessageTable} set processed_status = $1 where message_id in (${idIndices})`;
    logger('Logging what should have been logged: ', updateQuery);
    const values = [newStatus, ...messageIds];
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, values);
    return resultOfUpdate;
};
