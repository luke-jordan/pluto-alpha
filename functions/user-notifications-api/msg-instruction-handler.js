'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');

const moment = require('moment');
const uuid = require('uuid/v4');
const rdsUtil = require('./persistence/rds.notifications');


/**
 * Enforces instruction rules and ensures the message instruction is valid before it is persisted.
 * First it asserts whether all required properties are present in the instruction object. If so, then
 * condtional required properties are asserted. These are properties that are only required under certain condtions.
 * For example, if the message instruction has a recurring presentation then a recurrance instruction is required to
 * describe how frequently the notification should recur. The object properties recieved by this function are described below:
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
 * @param {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.validateMessageInstruction = (instruction) => {
    const requiredProperties = config.get('instruction.requiredProperties');
    for (let i = 0; i < requiredProperties.length; i++) {
        if (!instruction[requiredProperties[i]]) {
            throw new Error(`Missing required property value: ${requiredProperties[i]}`);
        }
    }
    switch (true) {
        case instruction.presentationType === 'RECURRING' && !instruction.recurrenceInstruction:
            throw new Error('recurrenceInstruction is required where presentationType is set to RECURRING.');
        case instruction.audienceType === 'INDIVIDUAL' && !instruction.selectionInstruction:
            throw new Error('selectionInstruction required on indivdual notification.');
        case instruction.audienceType === 'GROUP' && !instruction.selectionInstruction:
            throw new Error('selectionInstruction required on group notification.');
        case !instruction.templates.default && !instruction.templates.otherTemplates:
            throw new Error('Templates cannot be null.');
        default: 
           return;
    }
};

/**
 * This function takes the instruction passed by the caller, assigns it an instruction id, activates it,
 * and assigns default values where none are provided by the input object. Minimum required instruction properties are described below: 
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING and ONCE_OFF.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {string} defaultTemplate Required when otherTemplates is null. Templates describe the message to be shown in the notification.
 * @param {string} otherTemplates Required when defaultTemplate is null.
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceInstruction Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 */
const createPersistableObject = (instruction) => ({
    instructionId: uuid(),
    presentationType: instruction.presentationType,
    active: true,
    audienceType: instruction.audienceType,
    templates: {
        default: instruction.defaultTemplate,
        otherTemplates: instruction.otherTemplates ? instruction.otherTemplates : null
    },
    selectionInstruction: instruction.selectionInstruction ? instruction.selectionInstruction : null,
    recurrenceInstruction: instruction.recurrenceInstruction ? instruction.recurrenceInstruction : null,
    responseAction: instruction.responseAction ? instruction.responseAction : null,
    responseContext: instruction.responseContext ? instruction.responseContext : null,
    startTime: instruction.startTime ? instruction.startTime : moment().format(),
    endTime: instruction.endTime ? instruction.endTime : moment().add(500, 'years').format(),
    lastProcessedTime: moment().format(),
    messagePriority: instruction.messagePriority ? instruction.messagePriority : 0
});


/**
 * This function accepts a new instruction, validates the instruction, then persists it. Depending on the instruction, either
 * the whole or a subset of properties described below may provided as input. 
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING and ONCE_OFF.
 * @param {boolean} active Indicates whether the message is active or not.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {string} defaultTemplate Required when otherTemplates is null. Templates describe the message to be shown in the notification.
 * @param {string} otherTemplates Required when defaultTemplate is null.
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceInstruction Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @param {object} responseContext An object that includes details such as the boost ID.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.insertMessageInstruction = async (event) => {
    try {
        logger('msg instruction inserter received:', event);
        const params = event; // normalise event
        const persistableObject = createPersistableObject(params);
        logger('created persistable object:', persistableObject);
        const instructionEvalResult = exports.validateMessageInstruction(persistableObject);
        logger('Message instruction evaluation resulted in:', instructionEvalResult);
        const databaseResponse = await rdsUtil.insertMessageInstruction(persistableObject);
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

/**
 * This function deactivates a message instruction, stopping all future notifications from message instruction.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.deactivateMessageInstruction = async (event) => {
    try {
        logger('instruction deactivator recieved:', event);
        const params = event; // normalize
        const instructionId = params.instructionId;
        const databaseResponse = await rdsUtil.updateMessageInstruction(instructionId, 'active', false);
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

/**
 * This function accepts an instruction id and returns a message instruction from the database.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.getMessageInstruction = async (event) => {
    try {
        logger('instruction retreiver recieved:', event);
        const params = event; // normalize 
        const instructionId = params.instructionId;
        const databaseResponse = await rdsUtil.getMessageInstruction(instructionId);
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
