'use strict';

const logger = require('debug')('jupiter:user-notifications:rds');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

/**
 * This function accepts a persistable instruction object and inserts it into the database. It is vital that input to this function must
 * have gone through the message instruction handlers createPersistableObject function.
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @param {boolean} active Indicates whether the message is active or not.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {object} templates Required. Message instruction must include at least one template, ie, the notification message to be displayed, includes response actions, context, etc (see handler for more)
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller
 */
module.exports.insertMessageInstruction = async (persistableObject) => {
    const objectKeys = Object.keys(persistableObject);
    logger('Inserting object with keys: ', objectKeys);
    const insertionQuery = `insert into ${config.get('tables.messageInstructionTable')} (${opsUtil.extractQueryClause(objectKeys)}) values %L returning instruction_id, creation_time`;
    const insertionColumns = opsUtil.extractColumnTemplate(objectKeys);
    const insertArray = [persistableObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    logger('Instruction insertion db response:', databaseResponse);
    return databaseResponse.rows.map((insertionResult) => camelCaseKeys(insertionResult));
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

// used to find event-based messages
module.exports.findMsgInstructionTriggeredByEvent = async (eventType) => {
    const query = `select instruction_id, trigger_parameters from ${config.get('tables.messageInstructionTable')} where ` +
        `trigger_parameters -> 'triggerEvent' ? $1 and active = true and end_time > current_timestamp ` +
        `and presentation_type = $2 order by creation_time desc`;
    const results = await rdsConnection.selectQuery(query, [eventType, 'EVENT_DRIVEN']);
    logger('Found instructions for event? : ', results);
    return results.map((row) => camelCaseKeys(row));
};

module.exports.findMsgInstructionHaltedByEvent = async (eventType) => {
    const query = `select instruction_id from ${config.get('tables.messageInstructionTable')} where ` +
        `trigger_parameters -> 'haltingEvent' ? $1`;
    const results = await rdsConnection.selectQuery(query, [eventType]);
    return results.map((result) => result['instruction_id']); 
};

module.exports.getMessageIdsForInstructions = async (instructionIds, destinationUserId, soughtStatuses) => {
    const instructionIdIdxs = opsUtil.extractArrayIndices(instructionIds);
    const statusIdxs = opsUtil.extractArrayIndices(soughtStatuses, instructionIds.length + 1);

    const selectQuery = `select message_id from message_data.user_message where instruction_id in (${instructionIdIdxs}) ` + 
        `and processed_status in (${statusIdxs}) and destination_user_id = $${instructionIds.length + soughtStatuses.length + 1}`;

    const results = await rdsConnection.selectQuery(selectQuery, [...instructionIds, ...soughtStatuses, destinationUserId]);
    return results.map((result) => result['message_id']);
};

/**
 * This returns a list of message instructions that are still set to active true and not past their expiry. If the boolean is set to true
 * then it will also return instructions that in themselves are expired, but where there are still messages ready for sending
 * todo : clean up and optimize pretty soon
 */
module.exports.getCurrentInstructions = async (includePendingUserView = false) => {
    const instructTable = config.get('tables.messageInstructionTable');
    const messageTable = config.get('tables.userMessagesTable');

    // todo : when the last message is fetch, have a job that switches this to ended
    const activeSubClause = 'instruction.active = true and instruction.end_time > current_timestamp';

    // so first we get a list of instructions that are either recurring, event based, or once off but have some number unfetched
    const handledStatuses = ['FETCHED', 'SENT', 'DELIVERED', 'DISMISSED', 'UNDELIVERABLE'];
    const statusParamIdx = opsUtil.extractArrayIndices(handledStatuses);
    const selectNonZeroIds = `select instruction.instruction_id, count(message_id) as unfetched_message_count from ` +
        `${instructTable} as instruction inner join ${messageTable} as messages on instruction.instruction_id = messages.instruction_id ` +
        `where messages.processed_status not in (${statusParamIdx}) group by instruction.instruction_id`;

    const firstQueryResult = await rdsConnection.selectQuery(selectNonZeroIds, handledStatuses);
    logger('Result of first query: ', firstQueryResult);
    const nonZeroIds = firstQueryResult.filter((row) => row['unfetched_message_count'] > 0).map((row) => row['instruction_id']);
    logger('Filtered non zero IDs: ', nonZeroIds);
    
    const nonZeroIdSet = nonZeroIds.map((id) => `'${id}'`).join(',');
    
    const idKeyedCounts = firstQueryResult.reduce((obj, row) => ({ ...obj, [row['instruction_id']]: row['unfetched_message_count']}), {});
    logger('ID keyed counts: ', idKeyedCounts);

    const queryBase = `select instruction.*, count(message_id) as total_message_count from ${instructTable} as instruction ` + 
        `left join ${messageTable} as messages on instruction.instruction_id = messages.instruction_id`;

    const includePendingUserClause = `where (instruction.presentation_type in ('RECURRING', 'EVENT_DRIVEN') and ${activeSubClause}) ` +
    `or (instruction.presentation_type in ('ONCE_OFF') and instruction.instruction_id in (${nonZeroIdSet}))`;
    const whereClause = includePendingUserView ? includePendingUserClause : `where (${activeSubClause})`;
    
    const queryEnd = 'group by instruction.instruction_id';

    const assembledQuery = `${queryBase} ${whereClause} ${queryEnd}`;
    logger('Executing query: ', assembledQuery);
    const secondQueryResult = await rdsConnection.selectQuery(assembledQuery, []);
    logger('Result of second query, IDs: ', secondQueryResult.map((row) => row['instruction_id']));


    const extractUnfetchedCount = (instructionId) => (nonZeroIdSet.indexOf(instructionId) < 0 ? 0 : idKeyedCounts[instructionId]);
    const transformedInstructions = secondQueryResult.
        map((row) => ({...camelCaseKeys(row), unfetchedMessageCount: extractUnfetchedCount(row['instruction_id']) }));
    logger('Transformed: ', transformedInstructions);

    return transformedInstructions;
};

/**
 * This function accepts an message instruction id, a message instruction property, and the new value to be assigned to the property.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.updateMessageInstruction = async (instructionId, valuesToUpdate) => {
    logger('About to update message instruction.');
    const table = config.get('tables.messageInstructionTable');
    const key = { instructionId };
    const value = valuesToUpdate;
    const returnClause = 'updated_time';
    
    const response = await rdsConnection.updateRecordObject({ table, key, value, returnClause });
    logger('Result of message instruction update:', response);

    return response.map((updateResult) => camelCaseKeys(updateResult));
};

module.exports.updateInstructionState = async (instructionId, newProcessedStatus) => {
    const currentTime = moment().format();
    const valueMap = { processedStatus: newProcessedStatus, lastProcessedTime: currentTime };
    return exports.updateMessageInstruction(instructionId, valueMap);
};

module.exports.alterInstructionMessageStates = async (instructionId, oldStatuses, newStatus, endTime) => {
    const table = config.get('tables.userMessagesTable');
    const statusParams = opsUtil.extractArrayIndices(oldStatuses, 2);
    const seekMsgsQuery = `select message_id from ${table} where instruction_id = $1 and processed_status in (${statusParams})`;
    const messageIdRows = await rdsConnection.selectQuery(seekMsgsQuery, [instructionId, ...oldStatuses]);
    if (!Array.isArray(messageIdRows) || messageIdRows.length === 0) {
        logger('No messages found to update, returning');
        return 'NO_MESSAGES_TO_UPDATE';
    }
    
    const messageIds = messageIdRows.map((row) => row['message_id']);
    
    const value = { processedStatus: newStatus };
    if (endTime) {
        value.endTime = endTime.format();
    }

    const messageUpdateDefs = messageIds.map((messageId) => ({ table, key: { messageId }, value, returnClause: 'updated_time'}));

    const updateResponse = await rdsConnection.multiTableUpdateAndInsert(messageUpdateDefs, []);
    logger('Result of update on batch of messages: ', updateResponse);
    return updateResponse;
};
