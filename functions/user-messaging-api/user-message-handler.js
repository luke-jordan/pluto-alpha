'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler');
const uuid = require('uuid/v4');
const util = require('util');
const rdsUtil = require('./persistence/rds.notifications');

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;
const extractUserDetails = (event) => event.requestContext ? event.requestContext.authorizer : null;

/**
 * This function assembles the selected template and inserts relevent data where required.
 * @param {*} template The selected template.
 * @param {*} requestDetails Extra parameters sent with the callers request. If parameters contain known proporties such as parameters.boostAmount then the associated are executed.
 * With regards to boost amount it is extracted from request parameters and inserted into the boost template.
 */
const assembleTemplate = (template, requestDetails) => {
    switch (true) {
        case Object.keys(requestDetails).includes('parameters') && Object.keys(requestDetails.parameters).includes('boostAmount'):
            // if triggerBalanceFetch === true: get balance and include in template
            return util.format(template, requestDetails.parameters.boostAmount);
        default:
            return template;
    }
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
 * @param {object} requestDetails An object containing parameters past by the caller. These may include template format values as well as notification display instruction.
 */
const assembleUserMessages = async (instruction, destinationUserId = null) => {
    logger('Message assembler recieved instruction:', instruction);
    const selectionInstruction = instruction.selectionInstruction ? instruction.selectionInstruction : null;
    logger('Found selection instruction:', selectionInstruction);
    const userIds = destinationUserId ? [ destinationUserId ] : await rdsUtil.getUserIds(selectionInstruction);
    logger(`Got ${userIds.length} user id(s)`);
    // logger('Assembler recieved destination id:', destinationUserId);
    if (!Array.isArray(userIds) || userIds.length === 0) {
        logger('No users match this selection criteria, exiting');
        return [];
    }

    const rows = [];
    const templates = typeof instruction.templates === 'string' ? JSON.parse(instruction.templates) : instruction.templates;
    const template = templates.otherTemplates ? templates.otherTemplates : templates.default;
    const userMessage = assembleTemplate(template, instruction.requestDetails); // to become a generic way of formatting variables into template.
    
    for (let i = 0; i < userIds.length; i++) {
        rows.push({
            messageId: uuid(),
            destinationUserId: instruction.requestDetails.destination ? instruction.requestDetails.destination : userIds[i],
            instructionId: instruction.instructionId,
            userMessage,
            startTime: instruction.startTime,
            endTime: instruction.endTime,
            presentationType: instruction.presentationType,
            messagePriority: instruction.messagePriority
        });
    }
    
    logger(`created ${rows.length} user message rows. The first row looks like: ${JSON.stringify(rows[0])}`);
    return rows;
};

/**
 * This function accepts an instruction id, retrieves the associated instruction from persistence, assembles the user message, and finally
 * persists the assembled user message to RDS. The minimum required parameter that must be passed to this function is the instruction. Without
 * it the sun does not shine. Other properties may be included in the parameters, such as destinationId
 * @param {string} instructionId The instruction id assigned during instruction creation.
 * @param {string} destinationUserId Optional. This overrides the user ids indicated in the persisted message instruction's selectionInstruction property.
 * @param {object} parameters Required when assembling boost message. Contains details such as boostAmount, which is inserted into the boost template.
 * @param {boolean} triggerBalanceFetch Required on boost message assembly. Indicates whether to include the users new balance in the boost message.
 */
module.exports.createUserMessages = async (event) => {
    try {
        const params = extractEventBody(event);
        logger('Receieved params:', params);
        const instructionId = params.instructionId;
        const instruction = await rdsUtil.getMessageInstruction(instructionId);
        logger('Result of instruction extraction:', instruction);
        instruction.requestDetails = params;
        const rows = await assembleUserMessages(instruction, params.destinationUserId);
        if (!rows || rows.length === 0) {
            logger('No user messages generated, exiting');
            return { statusCode: 200, body: JSON.stringify({ result: 'NO_USERS' })};
        }

        const rowKeys = Object.keys(rows[0]);
        logger('Got keys:', rowKeys);
        const insertionResponse = await rdsUtil.insertUserMessages(rows, rowKeys);
        logger('User messages insertion resulted in:', insertionResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: insertionResponse
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
 * This function accepts a system wide user id. It then retrieves all recurring messages targeted at all users and includes the recieved
 * user id in the table of reciepients. This function essentially includes a new user into the loop, or the system wide 'mailing list'.
 * After running this function, the user should be able to recieve system wide recurring messages like everyone else.
 * @param {string} systemWideUserId The users system wide id.
 */
module.exports.syncUserMessages = async (event) => {
    try {
        const params = extractEventBody(event);
        const systemWideUserId = params.systemWideUserId; // validation
        logger('Got user id:', systemWideUserId);
        const instructions = await rdsUtil.getInstructionsByType('ALL_USERS', 'RECURRING');
        logger('Got instructions:', instructions);
        let rows = [];
        for (let i = 0; i < instructions.length; i++) {
            instructions[i].requestDetails = params;
            const result = await assembleUserMessages(instructions[i], systemWideUserId);
            rows = [...rows, ...result];
        }
        logger('Assembled user messages:', rows);
        const rowKeys = Object.keys(rows[0]);
        logger('Got keys:', rowKeys);
        const insertionResponse = await rdsUtil.insertUserMessages(rows, rowKeys);
        logger('User messages insertion resulted in:', insertionResponse);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: insertionResponse
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
 * This function inserts a push token object into RDS. It requires that the user calling this function also owns the token.
 * An evaluation of the requestContext is run prior to token manipulation. If request context evaluation fails access is forbidden.
 * Non standared propertied are ignored during the assembly of the persistable token object.
 * @param {string} userId The push tokens owner.
 * @param {string} provider The push tokens provider.
 * @param {string} token The push token.
 */
module.exports.insertPushToken = async (event) => {
    try {
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const params = extractEventBody(event);
        logger('Got event:', params);
        // uncomment if needed. along with tests. 
        // if (userDetails.systemWideUserId !== params.userId) {
        //     return { statusCode: 403 };
        // }

        const pushToken = await rdsUtil.getPushToken(params.provider, userDetails.systemWideUserId);
        logger('Got push token:', pushToken);
        if (pushToken) {
            const deletionResult = await rdsUtil.deletePushToken(params.provider, userDetails.systemWideUserId); // replace with new token?
            logger('Push token deletion resulted in:', deletionResult);
        }
        const newPushToken = { userId: userDetails.systemWideUserId, pushProvider: params.provider, pushToken: params.token };
        logger('Sending to RDS: ', newPushToken);
        const insertionResult = await rdsUtil.insertPushToken(newPushToken);
        return { statusCode: 200, body: JSON.stringify(insertionResult[0]) };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            result: 'ERROR',
            details: err.message
        };
    }
};

/**
 * This function accepts a token provider and its owners user id. It then searches for the associated persisted token object and deletes it from the 
 * database. As during insertion, only the tokens owner can execute this action. This is implemented through request context evaluation, where the userId
 * found within the requestContext object must much the value of the tokens owner user id.
 * @param {string} userId The tokens owner user id.
 * @param {string} provider The tokens provider.
 */
module.exports.deletePushToken = async (event) => {
    try {
        const userDetails = extractUserDetails(event);
        logger('Event: ', event);
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        const params = extractEventBody(event);
        if (userDetails.systemWideUserId !== params.userId) {
            return { statusCode: 403 };
        }
        const deletionResult = await rdsUtil.deletePushToken(params.provider, params.userId);
        logger('Push token deletion resulted in:', deletionResult);
        return {
            statusCode: 200,
            body: JSON.stringify({
                result: 'SUCCESS',
                details: deletionResult
            })
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                result: 'ERROR',
                details: err.message
            })
        };
    }
};
