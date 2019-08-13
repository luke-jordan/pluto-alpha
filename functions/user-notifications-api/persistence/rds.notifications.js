'use_strict';

const logger = require('debug')('jupiter:user-notifications:rds');
const config = require('config');
const decamelize = require('decamelize');
const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'));


const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

const createQueryArray = (object) => Object.keys(decamelizeKeys(object));

const createColumnArray = (object) => {
    const result = [];
    const keyArray = Object.keys(object);
    for (let i = 0; i < keyArray.length; i++) {
        result.push(`\${${keyArray[i]}}`);
    }
    return result;
};

/**
 * This function accepts a persistable instruction object and inserts it into the database. It is vital that input to this function must
 * have gone through the message instruction handlers createPersistableObject function.
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING and ONCE_OFF.
 * @param {boolean} active Indicates whether the message is active or not.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {object} templates Required. Message instruction must include at least one template, ie, the notification message to be displayed
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceInstruction Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @param {object} responseContext An object that includes details such as the boost ID.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {number} priority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller
 */
module.exports.insertMessageInstruction = async (persistableObject) => {
    const insertionQueryArray = createQueryArray(persistableObject);
    const insertionColumnsArray = createColumnArray(persistableObject);
    
    const insertionQuery = `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`;
    const insertionColumns = insertionColumnsArray.join(', ');
    const insertArray = [persistableObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    logger('Instruction insertion db response:', databaseResponse);
    return databaseResponse.rows;
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

    return response[0];
};


/**
 * This function accepts an message instruction id, a message instruction property, and the new value to be assigned to the property.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.updateMessageInstruction = async (instructionId, property, newValue) => {
    logger('About to update message instruction.');
    const query = `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning insertion_id, update_time`;
    const values = [property, newValue, instructionId];

    const response = await rdsConnection.updateRecord(query, values);
    logger('Result of message instruction update:', response);

    return response.rows;
};
