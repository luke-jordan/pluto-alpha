'use strict';

const logger = require('debug')('jupiter:user-notifications:rds');
const config = require('config');
const decamelize = require('decamelize');
const camelcase = require('camelcase');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));
const accountsTable = config.get('tables.accountLedger');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');
const camelCaseKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [camelcase(key)]: object[key] }), {});

/**
 * This function accepts a persistable instruction object and inserts it into the database. It is vital that input to this function must
 * have gone through the message instruction handlers createPersistableObject function.
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @param {boolean} active Indicates whether the message is active or not.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {object} templates Required. Message instruction must include at least one template, ie, the notification message to be displayed
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceInstruction Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @param {object} responseContext An object that includes details such as the boost ID.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller
 */
module.exports.insertMessageInstruction = async (persistableObject) => {
    const objectKeys = Object.keys(persistableObject);
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
    logger('User messages insertion resulted in:', insertionResult);
    return insertionResult.map((insertResult) => camelCaseKeys(insertResult));
};

/**
 * This function accepts an instruction ID and returns a message instruction from the database.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.getMessageInstruction = async (instructionId) => {
    const query = `select * from ${config.get('tables.messageInstructionTable')} where instruction_id = $1`;
    const value = [instructionId];

    const response = await rdsConnection.selectQuery(query, value);
    logger('Got this back from user message instruction extraction:', response);

    return camelCaseKeys(response[0]);
};


module.exports.getInstructionsByType = async (audienceType, presentationType) => {
    const query = `select * from ${config.get('tables.messageInstructionTable')} where audience_type = $1 and presentation_type = $2 and active = true`;
    const value = [audienceType, presentationType];

    const response = await rdsConnection.selectQuery(query, value);
    logger('Got this back from user message instruction extraction:', response);

    return response.map((instruction) => camelCaseKeys(instruction));
};

/**
 * This function accepts an message instruction id, a message instruction property, and the new value to be assigned to the property.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.updateMessageInstruction = async (instructionId, property, newValue) => {
    logger('About to update message instruction.');
    const query = `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning instruction_id, update_time`;
    const values = [property, newValue, instructionId];

    const response = await rdsConnection.updateRecord(query, values);
    logger('Result of message instruction update:', response);

    return response.rows.map((insertionResult) => camelCaseKeys(insertionResult));
};

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
}

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

const assembleQueryClause = (selectionMethod, universeDefinition) => {
    if (selectionMethod === 'whole_universe') {
        logger('We are selecting all parts of the universe');
        const [conditionClauses, conditionValues] = extractWhereClausesValues(universeDefinition);
        const whereClause = conditionClauses.join(' and ');
        const selectionQuery = `select account_id, owner_user_id from ${accountsTable} where ${whereClause}`;
        return [selectionQuery, conditionValues];
    } else if (selectionMethod === 'random_sample') {
        logger('We are selecting some random sample of a universe');
        const samplePercentage = Number(universeDefinition.replace(/^0./, '')); // validate integer
        if (isNaN(samplePercentage)) {
            throw new Error('Invalid row percentage.');
        }
        const selectionQuery = `select owner_user_id from ${accountsTable} tablesample bernoulli ($1)`;
        const conditionValues = samplePercentage;
        return [selectionQuery, [conditionValues]];
    } else if (selectionMethod === 'match_other') {
        logger('We are selecting so as to match another entity');
    }

    throw new Error('Invalid selection method provided: ', selectionMethod);
};

const extractUserIds = async (selectionClause) => {
    logger('Selecting accounts according to: ', selectionClause);
    const clauseComponents = selectionClause.split(' ');
    logger('Split pieces: ', clauseComponents);
    const hasMethodParameters = clauseComponents[1] !== 'from';
    
    const selectionMethod = clauseComponents[0];
    const universeComponents = selectionClause.match(/#{{.*?}}|#{.*?}/g);
    const universeComponent = universeComponents[hasMethodParameters ? 1 : 0];
    let universeDefinition;
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

module.exports.insertPushToken = async (pushTokenObject) => {
    const objectKeys = Object.keys(pushTokenObject);
    const insertionQuery = `insert into ${config.get('tables.pushTokenTable')} (${extractQueryClause(objectKeys)}) values %L returning insertion_id, creation_time`;
    const insertionColumns = extractColumnTemplate(objectKeys);
    const insertArray = [pushTokenObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    logger('Push token insertion resulted in:', databaseResponse);
    return databaseResponse.rows.map((insertionResult) => camelCaseKeys(insertionResult));
};

module.exports.getPushToken = async (provider, userId) => {
    const query = `select * from ${config.get('tables.pushTokenTable')} where push_provider = $1 and user_id = $2`;
    const value = [provider, userId];

    const result = await rdsConnection.selectQuery(query, value);
    logger('Got this back from user push token extraction:', result);

    return camelCaseKeys(result[0]);
};

module.exports.deactivatePushToken = async (provider) => {
    logger('About to update push token.');
    const query = `update ${config.get('tables.pushTokenTable')} set active = false where push_provider = $1 returning insertion_id, update_time`;
    const values = [provider];

    const response = await rdsConnection.updateRecord(query, values);
    logger('Push token deactivation resulted in:', response);

    return response.rows.map((deactivationResult) => camelCaseKeys(deactivationResult));
};

module.exports.deletePushToken = async (provider, userId) => {
    const columns = ['push_provider', 'user_id']
    const values = [provider, userId];

    const result = await rdsConnection.deleteRow(config.get('tables.pushTokenTable'), columns, values);
    logger('Push token deletion resulted in:', result);

    return result.rows.map((deletionResult) => camelCaseKeys(deletionResult));
};
