'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');
const decamelize = require('decamelize')
const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'));


module.exports.insertMessageInstruction = async (event) => {
    try {
        logger('msg instruction inserter received:', event);
        const params = event; // normalise event
        const persistableObject = createPersistableObject(params);
        logger('created persistable object:', persistableObject);
        const instructionEvalResult = exports.evaluateMessageInstruction(persistableObject);
        logger('Message instruction evaluation resulted in:', instructionEvalResult);
        const databaseResponse = await insertMessageInstruction(persistableObject);
        logger('Recieved this back from message instruction insertion:', databaseResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: databaseResponse
            })
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: err.message })
        };
    }
};


module.exports.deactivateMessageInstruction = async (event) => {
    try {
        logger('instruction deactivator recieved:', event);
        const params = event; // normalize
        const instructionId = params.instructionId;
        const databaseResponse = await updateMessageInstruction(instructionId, 'active', false);
        logger('Result of instruction deactivation:', databaseResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: databaseResponse
            })
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: err.message })
        };
    }
};


module.exports.getMessageInstruction = async (event) => {
    try {
        logger('instruction retreiver recieved:', event);
        const params = event; // normalize
        const instructionId = params.instructionId;
        const databaseResponse = await rdsGetMessageInstruction(instructionId);
        logger('Result of message instruction extraction:', databaseResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: databaseResponse
            })
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { statusCode: 500,
            body: JSON.stringify({ message: err.message })
        };
    }
};

// to be moved to persistence/ directory
const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

// to be moved to persistence/ directory
const createInsertionArray = (object, outputType = 'columns') => {
    if (outputType === 'query') {
        return Object.keys(decamelizeKeys(object));
    }
    if (outputType === 'columns') {
        let result = [];
        const keyArray = Object.keys(object);
        for (let i = 0; i < keyArray.length; i++) {
            result.push(`\${${keyArray[i]}}`);
        }
        return result;
    }
};

// to be moved to persistence/ directory
const insertMessageInstruction = async (persistableObject) => {
    const insertionQueryArray = createInsertionArray(persistableObject, 'query');
    const insertionColumnsArray = createInsertionArray(persistableObject, 'columns');
    
    const insertionQuery = `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`;
    const insertionColumns = insertionColumnsArray.join(', ');
    const insertArray = [persistableObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    return databaseResponse.rows;
};


// to be moved to persistence/ directory
const rdsGetMessageInstruction = async (instructionId) => {
    const query = `select * from ${config.get('tables.messageInstructionTable')} where instruction_id = $1`;
    const value = [instructionId];

    const response = await rdsConnection.selectQuery(query, value);
    logger('Got this back from user message instruction extraction:', response);

    return response[0];
};

// to be moved to persistence/ directory
const updateMessageInstruction = async (instructionId, property, newValue) => {
    logger('About to update message instruction.');
    const query = `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning insertion_id, update_time`;
    const values = [property, newValue, instructionId];

    const response = await rdsConnection.updateRecord(query, values);
    logger('Result of message instruction update:', response);

    return response.rows;
};


const createPersistableObject = (instruction) => ({
    instructionId: uuid(),
    presentationType: instruction.presentationType,
    active: true,
    audienceType: instruction.audienceType,
    templates: {
        default: instruction.defaultTemplate,
        otherTemplates: instruction.otherTemplates? instruction.otherTemplates: null
    },
    selectionInstruction: instruction.selectionInstruction? instruction.selectionInstruction: null,
    recurrenceInstruction: instruction.recurrenceInstruction? instruction.recurrenceInstruction: null,
    responseAction: instruction.responseAction? instruction.responseAction: null,
    responseContext: instruction.responseContext? instruction.responseContext: null,
    startTime: instruction.startTime? instruction.startTime: moment()._d,
    endTime: instruction.endTime? instruction.endTime: moment().add(500, 'years')._d, // notifications that will outlive us all
    priority: instruction.priority? instruction.priority: 0
});


module.exports.evaluateMessageInstruction = (instruction) => {
    const requiredProperties = ['presentationType', 'audienceType', 'templates'];
    for (let i = 0; i < requiredProperties.length; i++) {
        if (!instruction[requiredProperties[i]]) {
            throw new Error(`Missing required property value: ${requiredProperties[i]}`);
        }
    }
    if (instruction.presentationType === 'RECURRING' && !instruction.recurrenceInstruction) {
        throw new Error('recurrenceInstruction is required where presentationType is set to RECURRING.');
    }
    if (instruction.audienceType === 'INDIVIDUAL' && !instruction.selectionInstruction) {
        throw new Error('selectionInstruction required on indivdual notification.');
    }
    if (instruction.audienceType === 'GROUP' && !instruction.selectionInstruction) {
        throw new Error('selectionInstruction required on group notification.');
    }
    if (!instruction.templates.default && !instruction.templates.otherTemplates) {
        throw new Error('Templates cannot be null.');
    }
};
