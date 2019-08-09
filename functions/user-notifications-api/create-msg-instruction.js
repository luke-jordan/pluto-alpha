'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');
const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'))


module.exports.createMsgInstructions = async (event) => {
    try {
        logger('msg instruction inserter received:', event);
        const params = event; // normalise event
        const persistableObject = createPersistableObject(params);
        logger('created persistable object:', persistableObject);
        const instructionEvalResult = exports.evaluateMessageInstruction(persistableObject);
        logger('Message instruction evaluation resulted in:', instructionEvalResult);

        const databaseResponse = await insertMessageInstruction(persistableObject)
        logger('Recieved this back from message instruction insertion:', databaseResponse);
        return databaseResponse.rows
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { error: err.message };
    }
};


// to be moved to persistence/ directory
const insertMessageInstruction = async (persistableObject) => {
    const insertionQueryArray = [
        'presentation_type',
        'active',
        'audience_type',
        'templates',
        'selection_instruction',
        'recurrence_instruction',
        'response_action',
        'start_time',
        'end_time',
        'priority'
    ];
    
    const insertionQuery = `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`;
    const insertionColumns = '${presentationType} ${active} ${audienceType} ${templates} ${selectionInstruction} ${recurrenceInstruction} ${responseAction} ${responseContext} ${startTime} ${endTime} ${priority}'; 
    const insertArray = [persistableObject];
    const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
    return databaseResponse;
};


const createPersistableObject = (instruction) => ({
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
    startTime: instruction.startTime? instruction.startTime: null,
    endTime: instruction.endTime? instruction.endTime: null,
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