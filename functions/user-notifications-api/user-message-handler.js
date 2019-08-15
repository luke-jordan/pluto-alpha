'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler');
const config = require('config');
const util = require('util');
const moment = require('moment');
const rdsUtil = require('./persistence/rds.notifications');

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;

module.exports.assembleMessage = (template, requestDetails) => {
    switch (true) {
        case Object.keys(requestDetails).includes('parameters') && Object.keys(requestDetails.parameters).includes('boostAmount'):
            return util.format(template, requestDetails.parameters.boostAmount);
        default:
            return template;
    };
};

/**
 * This function takes a message instruction and returns an array of user message rows. Instruction properties are as follows:
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @param {boolean} active Indicates whether the message is active or not.
 * @param {string} audienceType Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {object} templates Message instruction must include at least one template, ie, the notification message to be displayed
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceInstruction Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @param {object} responseContext An object that includes details such as the boost ID.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.createUserMessages = async (instruction) => {
    const selectionInstruction = instruction.selectionInstruction ? JSON.parse(instruction.selectionInstruction) : null;
    logger('Found selection instruction:', selectionInstruction);
    logger('Message assembler recieved instruction:', instruction);
    let userIds = [];
    switch (true) {
        case instruction.audienceType === 'INDIVIDUAL':
            userIds = instruction.requestDetails.destination ? [instruction.requestDetails.destination] : [selectionInstruction.userId];
            break;
        case instruction.audienceType === 'GROUP':
            userIds = await rdsUtil.getUserIds(selectionInstruction.selectionType, selectionInstruction.proportionUsers);
            break;
        case instruction.audienceType === 'ALL_USERS':
            userIds = await rdsUtil.getUserIds();
            break
        default:
            throw new Error(`Unsupperted message audience type: ${instruction.audienceType}`);
    };
    const rows = [];
    let template = JSON.parse(instruction.templates).otherTemplates ? JSON.parse(instruction.templates).otherTemplates : JSON.parse(instruction.templates).default;
    const userMessage = exports.assembleMessage(template, instruction.requestDetails); // to become a generic way of formatting variables into template.
    for (let i = 0; i < userIds.length; i++) {
        rows.push({
            destinationUserId: instruction.destination ? instruction.destination : userIds[i],
            instructionId: instruction.instructionId,
            message: userMessage,
            presentationInstruction: null // possible property for instructions to be executed before message display
        });
    }
    logger(`created ${rows.length} user message rows. The first row looks like: ${JSON.stringify(rows[0])}`);
    return rows;
};

/**
 * 
 * @param {string} instructionId The instruction id assigned during instruction creation.
 */
module.exports.populateUserMessages = async (event) => {
    try {
        const params = extractEventBody(event);
        logger('Receieved params:', params);
        const instructionId = params.instructionId;
        const instruction = await rdsUtil.getMessageInstruction(instructionId);
        logger('Result of instruction extraction:', instruction);
        instruction.requestDetails = params;
        const payload = await exports.createUserMessages(instruction);
        const insertionResponse = await rdsUtil.insertUserMessages(payload);
        logger('User messages insertion resulted in:', insertionResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                messageInsertionResult: insertionResponse
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
