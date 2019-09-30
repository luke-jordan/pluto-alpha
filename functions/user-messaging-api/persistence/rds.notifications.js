'use strict';

const logger = require('debug')('jupiter:user-notifications:rds');
const config = require('config');
const moment = require('moment');
const decamelize = require('decamelize');
const camelcase = require('camelcase');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));
const accountsTable = config.get('tables.accountLedger');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');
const extractParamIndices = (values, startIndex = 1) => values.map((_, idx) => `$${idx + startIndex}`).join(', ');

const camelCaseKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [camelcase(key)]: object[key] }), {});

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
    const insertionQuery = `insert into ${config.get('tables.messageInstructionTable')} (${extractQueryClause(objectKeys)}) values %L returning instruction_id, creation_time`;
    const insertionColumns = extractColumnTemplate(objectKeys);
    const insertArray = [persistableObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    logger('Instruction insertion db response:', databaseResponse);
    return databaseResponse.rows.map((insertionResult) => camelCaseKeys(insertionResult));
};

/**
 * This function inserts user messages in bulk. It accepts an array of user message objects and an array of a user message object's keys.
 * @param {array} rows An array of persistable user message rows.
 * @param {array} objectKeys An array of a rows object keys.
 */ 
module.exports.insertUserMessages = async (rows, objectKeys) => {
    const messageQueryDef = {
        query: `insert into ${config.get('tables.userMessagesTable')} (${extractQueryClause(objectKeys)}) values %L returning message_id, creation_time`,
        columnTemplate: extractColumnTemplate(objectKeys),
        rows: rows
    };
    // logger('Created insertion query:', messageQueryDef);

    const insertionResult = await rdsConnection.largeMultiTableInsert([messageQueryDef]);
    // logger('User messages insertion resulted in:', insertionResult);
    const insertionRows = insertionResult[0]; // as multi table returns array of query
    return insertionRows.map((insertResult) => camelCaseKeys(insertResult));
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
        query = `${query} and audience_type in (${extractParamIndices(audienceTypes, paramStartIndex)})`;
        values = values.concat(audienceTypes);
        paramStartIndex = paramStartIndex + audienceTypes.length;
    }

    if (Array.isArray(processedStatuses) && processedStatuses.length > 0) {
        query = `${query} and processed_status in (${extractParamIndices(processedStatuses, paramStartIndex)})`;
        values = values.concat(processedStatuses);
        paramStartIndex = paramStartIndex + processedStatuses.length;
    }

    logger(`Finding message instructions using query: ${query}, and values: ${JSON.stringify(values)}`);
    const response = await rdsConnection.selectQuery(query, values);
    logger('Got this back from user message instruction extraction:', response);

    return response.map((instruction) => camelCaseKeys(instruction));
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
    const statusParamIdx = extractParamIndices(handledStatuses)
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
    const whereClause = !includePendingUserView ? `where (${activeSubClause})` :
        `where (instruction.presentation_type in ('RECURRING', 'EVENT_DRIVEN') and ${activeSubClause}) ` +
        `or (instruction.presentation_type in ('ONCE_OFF') and instruction.instruction_id in (${nonZeroIdSet}))`;
    const queryEnd = 'group by instruction.instruction_id';

    const assembledQuery = `${queryBase} ${whereClause} ${queryEnd}`;
    logger('Executing query: ', assembledQuery);
    const secondQueryResult = await rdsConnection.selectQuery(assembledQuery, []);
    logger('Result of second query, IDs: ', secondQueryResult.map((row) => row['instruction_id']));


    const extractUnfetchedCount = (instructionId) => nonZeroIdSet.indexOf(instructionId) === -1 ? 0 : idKeyedCounts[instructionId];
    const transformedInstructions = secondQueryResult.map((row) => 
        ({...camelCaseKeys(row), unfetchedMessageCount: extractUnfetchedCount(row['instruction_id']) }));
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

module.exports.alterInstructionMessageStates = async (instructionId, oldStatuses, newStatus) => {
    const table = config.get('tables.userMessagesTable');
    const statusParams = extractParamIndices(oldStatuses, 2);
    const seekMsgsQuery = `select message_id from ${table} where instruction_id = $1 and processed_status in (${statusParams})`;
    const messageIdRows = await rdsConnection.selectQuery(seekMsgsQuery, [instructionId, ...oldStatuses]);
    if (!Array.isArray(messageIdRows) || messageIdRows.length === 0) {
        logger('No messages found to update, returning');
        return 'NO_MESSAGES_TO_UPDATE';
    }
    
    const messageIds = messageIdRows.map((row) => row['message_id']);
    
    const value = { processedStatus: newStatus };
    const messageUpdateDefs = messageIds.map((messageId) => ({ table, key: { messageId }, value, returnClause: 'updated_time'}));

    const updateResponse = await rdsConnection.multiTableUpdateAndInsert(messageUpdateDefs, []);
    logger('Result of update on batch of messages: ', updateResponse);
    return updateResponse; // camelize?
}

/////////////////////////////////////////////////////////////////////////////////////////
///////////////////////// User ID extraction begins here ////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////

const validateAndExtractUniverse = (universeComponent) => {
    logger('Universe component: ', universeComponent);
    const universeMatch = universeComponent.match(/#{(.*)}/);
    logger('Universe match: ', universeMatch);
    if (!universeMatch || universeMatch.length === 0) {
        throw new Error('Error! Universe definition passed incorrectly: ', universeComponent);
    }

    logger('Parsing: ', universeMatch[1]);
    const universeDefinition = JSON.parse(universeMatch[1]);
    logger('Resulting definition: ', universeDefinition);
    if (typeof universeDefinition !== 'object' || Object.keys(universeDefinition) === 0) {
        throw new Error('Error! Universe definition not a valid object');
    }

    return universeDefinition;
};


// note : this _could_ be simplified by relying on ordering of Object.keys, but that would be dangerous/fragile
const extractSubClauseAndValues = (universeDefinition, currentIndex, currentKey) => {
    if (currentKey === 'specific_accounts') {
        logger('Sepcific account IDs selected');
        const accountIds = universeDefinition[currentKey];
        const placeHolders = accountIds.map((_, index) => `$${currentIndex + index + 1}`).join(', ');
        logger('Created place holder: ', placeHolders);
        const assembledClause = `owner_user_id in (${placeHolders})`;
        return [assembledClause, accountIds, currentIndex + accountIds.length];
    } else if (currentKey === 'client_id') {
        const newIndex = currentIndex + 1;
        const assembledClause = `responsible_client_id = $${newIndex}`;
        return [assembledClause, [universeDefinition[currentKey]], newIndex];
    }
    const newIndex = currentIndex + 1;
    return [`${decamelize(currentKey, '_')} = $${newIndex}`, [universeDefinition[currentKey]], newIndex];
};

// const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

const extractWhereClausesValues = (universeDefinition) => {
    const [clauseStrings, clauseValues] = [[], []];
    const universeKeys = Object.keys(universeDefinition);
    let currentIndex = 0;
    universeKeys.forEach((key) => {
        logger('Next clause extraction, current key: ', key, ' and current index: ', currentIndex);
        const [nextClause, nextValues, newCurrentIndex] = extractSubClauseAndValues(universeDefinition, currentIndex, key);
        clauseStrings.push(nextClause);
        clauseValues.push(...nextValues);
        currentIndex = newCurrentIndex;
    });
    return [clauseStrings, clauseValues];
};

const assembleMatchEntityClauseValues = (universeDefinition) => {
    const entityType = universeDefinition.entityType;
    logger('Matching entity of type: ', entityType);
    if (entityType === 'boost') {
        const boostAccountTable = config.get('tables.boostAccountTable');
        const selectQuery = `select distinct(owner_user_id) from ${accountsTable} inner join ${boostAccountTable} on ` +
            `${accountsTable}.account_id = ${boostAccountTable}.account_id where boost_id = $1`;
        return [selectQuery, [universeDefinition.entityId]];
    }
    throw new Error('Unimplemented matching entity');
};

const assembleQueryClause = (selectionMethod, universeDefinition) => {
    if (selectionMethod === 'whole_universe') {
        logger('We are selecting all parts of the universe');
        const [conditionClauses, conditionValues] = extractWhereClausesValues(universeDefinition);
        const whereClause = conditionClauses.join(' and ');
        const selectionQuery = `select account_id, owner_user_id from ${accountsTable} where ${whereClause}`;
        return [selectionQuery, conditionValues];
    } else if (selectionMethod === 'random_sample') {
        logger('We are selecting some random sample of a universe');
        const samplePercentage = Number(universeDefinition.replace(/^0./, ''));
        if (isNaN(samplePercentage)) {
            throw new Error('Invalid row percentage.');
        }
        const selectionQuery = `select owner_user_id from ${accountsTable} tablesample bernoulli ($1)`;
        const conditionValues = samplePercentage;
        return [selectionQuery, [conditionValues]];
    } else if (selectionMethod === 'match_other') {
        logger('We are selecting so as to match another entity: ', universeDefinition);
        return assembleMatchEntityClauseValues(universeDefinition);
    }

    throw new Error(`Invalid selection method provided: ${selectionMethod}`);
};

const extractUserIds = async (selectionClause) => {
    logger('Selecting accounts according to: ', selectionClause);
    const clauseComponents = selectionClause.split(' ');
    logger('Split pieces: ', clauseComponents);
    const hasMethodParameters = clauseComponents[1] !== 'from';
    
    const selectionMethod = clauseComponents[0];
    const universeComponents = selectionClause.match(/#{{.*?}}|#{.*?}/g);
    const universeComponent = universeComponents[hasMethodParameters ? 1 : 0];
    let universeDefinition = null;
    if (selectionMethod === 'random_sample') {
        universeDefinition = universeComponents[0].replace(/#{|\}/g, '');
    } else {
        universeDefinition = validateAndExtractUniverse(universeComponent);
    }
    
    const [selectionQuery, selectionValues] = assembleQueryClause(selectionMethod, universeDefinition);
    logger('Assembled selection clause: ', selectionQuery);
    logger('And selection values: ', selectionValues);

    const queryResult = await rdsConnection.selectQuery(selectionQuery, selectionValues);
    logger('Number of records from query: ', queryResult.length);

    return queryResult.map((row) => row['owner_user_id']);
};

/**
 * This function accepts a selection instruction and returns an array of user ids.
 * @param {string} selectionInstruction see DSL documentation.
 */
module.exports.getUserIds = async (selectionInstruction) => {
    const userIds = await extractUserIds(selectionInstruction);
    logger('Got this back from user ids extraction:', userIds);
    return userIds;
};

const executeQueryAndGetIds = async (query, values, idColumn = 'destination_user_id') => {
    const rows = await rdsConnection.selectQuery(query, values);
    return rows.map((row) => row[idColumn]);
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
    const intervalPromise = executeQueryAndGetIds(minIntervalQuery, [instructionId, durationClause])

    // here consciously allowing this to be everything -- could do an 'in' clause with user IDs but very complex and probably 
    // has little gain, esp as might create enourmous query when have 100k + users and evaluating a generic recurrence
    const minQueueQuery = `select destination_user_id from ${messageTable} where processed_status = $1 ` + 
        `group by destination_user_id having count(*) > $2`;
    const queueSizePromise = executeQueryAndGetIds(minQueueQuery, ['READY_FOR_SENDING', recurrenceParameters.maxInQueue]);

    const [usersWithinInterval, usersWithQueue] = await Promise.all([intervalPromise, queueSizePromise]);
    // this will mean redundancy but removing overlap would serve little purpose, hence leaving it
    const idsToFilter = usersWithinInterval.concat(usersWithQueue);
    logger('And have these IDs to remove: ', idsToFilter);

    return userIds.filter((id) => !idsToFilter.includes(id));
};

/////////////////////////////////////////////////////////////////////////////////////////
///////////////////////// Final: push token extraction begins here //////////////////////
/////////////////////////////////////////////////////////////////////////////////////////

module.exports.insertPushToken = async (pushTokenObject) => {
    const insertionQueryArray = [
        'userId', 'pushProvider', 'pushToken'
    ];
    const insertionQuery = `insert into ${config.get('tables.pushTokenTable')} (${extractQueryClause(insertionQueryArray)}) values %L returning insertion_id, creation_time`;
    const insertionColumns = extractColumnTemplate(insertionQueryArray);

    const insertArray = [pushTokenObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    logger('Push token insertion resulted in:', databaseResponse);
    return databaseResponse.rows.map((insertionResult) => camelCaseKeys(insertionResult));
};

module.exports.getPushTokens = async (userIds, provider) => {
    const haveProvider = typeof provider === 'string';
    const idParamIdxs = extractParamIndices(userIds, haveProvider ? 2 : 1);
    
    // note : ordering by creation time ascending means that the dict assembly will retain only the most recently
    // created in the edge case where provider is not given and there are duplicates for a user id (todo : test this)
    const query = `select user_id, push_token from ${config.get('tables.pushTokenTable')} where active = true and ` +
        `${haveProvider ? 'push_provider = $1 and ' : ''} user_id in (${idParamIdxs}) order by creation_time asc`;
    const values = haveProvider ? [provider, ...userIds] : userIds;
    
    logger('Query for tokens: ', query);
    logger('Values for tokens: ', values);

    const result = await rdsConnection.selectQuery(query, values);
    logger('Got this back from user push token extraction:', result);

    return result.reduce((obj, row) => ({ ...obj, [row['user_id']]: row['push_token']}), {});
};

module.exports.deactivatePushToken = async (provider, userId, valuesToUpdate) => {
    logger('About to update push token.');
    const table = config.get('tables.pushTokenTable');
    const key = { userId, provider };
    const value = valuesToUpdate;
    const returnClause = 'insertion_time';

    const response = await rdsConnection.updateRecordObject({ table, key, value, returnClause });
    logger('Push token deactivation resulted in:', response);

    return response.map((deactivationResult) => camelCaseKeys(deactivationResult));
};

module.exports.deletePushToken = async (provider, userId) => {
    const columns = ['push_provider', 'user_id'];
    const values = [provider, userId];

    const result = await rdsConnection.deleteRow(config.get('tables.pushTokenTable'), columns, values);
    logger('Push token deletion resulted in:', result);

    return result.rows;
};
