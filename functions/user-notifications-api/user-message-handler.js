'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler');
const moment = require('moment');
const rdsUtil = require('./persistence/rds.notifications');


/**
 * This function takes a message instruction and returns an array of user message rows. Instruction properties are as follows:
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType How the message should be presented. Valid values are RECURRING and ONCE_OFF.
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
    logger('Found selection instruction:', instruction.selectionInstruction);
    let userIds = [];
    switch (true) {
        case instruction.audienceType === 'INDIVIDUAL':
            userIds.push(instruction.selectionInstruction.userId);
            break;
        case instruction.audienceType === 'GROUP':
            userIds = await rdsUtil.getUserIds(instruction.selectionInstruction.selectionType, instruction.selectionInstruction.proportionUsers);
            break;
        case instruction.audienceType === 'ALL_USERS':
            userIds = await rdsUtil.getUserIds();
            break
        default:
            throw new Error(`Unsupperted message audience type: ${instruction.audienceType}`);
    };
    const rows = [];
    const userMessage = instruction.templates.otherTemplates ? instruction.templates.otherTemplates : instruction.templates.default;
    for (let i = 0; i < userIds.length; i++) {
        rows.push({
            systemWideUserId: userIds[i],
            instructionId: instruction.instructionId,
            message: userMessage
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
        const params = event; // normalize
        logger('Receieved params:', params);
        const instructionId = params.instructionId;
        const instruction = await rdsUtil.getMessageInstruction(instructionId);
        logger('Result of instruction extraction:', instruction);
        const payload = await exports.createUserMessages(instruction);
        const insertionResponse = await rdsUtil.insertUserMessages(payload);
        logger('User messages insertion resulted in:', insertionResponse);
        const updateResponse = await rdsUtil.updateMessageInstruction(instructionId, 'last_processed_time', moment().format());
        logger('Instruction update resulted in:', updateResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                messageInsertionResult: insertionResponse,
                instructionUpdateResult: updateResponse
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
