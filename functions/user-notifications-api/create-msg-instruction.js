'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');
const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'))

module.exports.createMsgInstructions = async (event) => {
    try {
        logger('msg instruction inserter received:', event);
        const params = event; // normalise event

        const persistableObject = {
            presentationType: params.presentationType,
            active: true,
            audienceType: params.audienceType,
            templates: {
                default: params.defaultTemplate,
                otherTemplates: params.otherTemplates? params.otherTemplates: null
            },
            selectionInstruction: params.selectionInstruction? params.selectionInstruction: null,
            recurrenceInstruction: params.recurrenceInstruction? params.recurrenceInstruction: null,
            responseAction: params.responseAction? params.responseAction: null,
            responseContext: params.responseContext? params.responseContext: null,
            startTime: params.startTime? params.startTime: null,
            endTime: params.endTime? params.endTime: null,
            priority: params.priority? params.priority: 0
        };
        logger('created persistable object:', persistableObject);
        const instructionEvalResult = exports.evaluateMessageInstruction(persistableObject);
        logger('Message instruction evaluation resulted in:', instructionEvalResult);

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
        // to be moved to persistence/ directory
        const insertionQuery = `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`;
        const insertionColumns = '${presentationType} ${active} ${audienceType} ${templates} ${selectionInstruction} ${recurrenceInstruction} ${responseAction} ${responseContext} ${startTime} ${endTime} ${priority}'; 
        const insertArray = [persistableObject];
        const databaseResponse = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertArray);
        logger('Recieved this back from message instruction insertion:', databaseResponse);
        return databaseResponse.rows
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { error: err.message };
    }
};

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