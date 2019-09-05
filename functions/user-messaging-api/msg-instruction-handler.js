'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');

const moment = require('moment');
const uuid = require('uuid/v4');

const rdsUtil = require('./persistence/rds.notifications');
const msgUtil = require('./msg.util');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region' )});

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;

/**
 * Enforces instruction rules and ensures the message instruction is valid before it is persisted.
 * First it asserts whether all required properties are present in the instruction object. If so, then
 * condtional required properties are asserted. These are properties that are only required under certain condtions.
 * For example, if the message instruction has a recurring presentation then a recurrance instruction is required to
 * describe how frequently the notification should recur. The object properties recieved by this function are described below:
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
        case !instruction.templates.sequence && !instruction.templates.template:
            throw new Error('Templates must define either a sequence or a single template.');
        default: 
           return;
    }
};

/** todo : validate templates
 * This function takes the instruction passed by the caller, assigns it an instruction id, activates it,
 * and assigns default values where none are provided by the input object. Minimum required instruction properties are described below: 
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {string} defaultTemplate Required when otherTemplates is null. Templates describe the message to be shown in the notification.
 * @param {string} otherTemplates Required when defaultTemplate is null.
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceInstruction Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 */
const createPersistableObject = (instruction, creatingUserId) => {
    
    const instructionId = uuid();
    const startTime = instruction.startTime || moment().format();
    const endTime = instruction.endTime || moment().add(500, 'years').format();
    const messagePriority = instruction.messagePriority || 0;

    const presentationType = instruction.presentationType;
    let processedStatus = presentationType === 'ONCE_OFF' ? 'READY_FOR_SENDING' : 'CREATED';

    return {
        instructionId,
        creatingUserId,
        startTime,
        endTime,
        presentationType,
        processedStatus,
        active: true,
        audienceType: instruction.audienceType,
        templates: instruction.templates,
        selectionInstruction: instruction.selectionInstruction ? instruction.selectionInstruction : null,
        recurrenceInstruction: instruction.recurrenceInstruction ? JSON.stringify(instruction.recurrenceInstruction) : null,
        lastProcessedTime: moment().format(),
        messagePriority
    };
};

const triggerTestOrProcess = async (instructionId, creatingUserId, params) => {
    const createMessagesFunction = config.get('lambdas.generateUserMessages');

    // first, we check if there should be a test first. if so, we process for that user.
    if (typeof params.fireTestMessage === 'boolean' && params.fireTestMessage) {
        const instructionPayload = { instructionId, destinationUserId: creatingUserId };
        const testRes = await lambda.invoke(msgUtil.lambdaInvocation(createMessagesFunction, instructionPayload)).promise();
        logger('Fired off test result: ', testRes);
        return { result: 'FIRED_TEST' };
    };

    // second, if there was no test instruction, then unless we have an explicit 'hold', we create the messages for 
    // once off messages right away (on assumption they should go out)
    const holdOffInstructed = typeof params.holdFire === 'boolean' && params.holdFire;
    if (params.presentationType === 'ONCE_OFF' && !holdOffInstructed) {
        const fireResult = await lambda.invoke(msgUtil.lambdaInvocation(createMessagesFunction, { instructionId })).promise();
        logger('Fired off process instruction: ', fireResult);
        return { result: 'FIRED_INSTRUCT' };
    };

    return { result: 'INSTRUCT_STORED '};

};

/**
 * This function accepts a new instruction, validates the instruction, then persists it. Depending on the instruction, either
 * the whole or a subset of properties described below may provided as input. 
 * 
 * Note on templates: They can construct linked series of messages for users, depending on the top-level key, which can be either
 * "template", or "sequence". If it template, then only one message is generated, if it is sequence, then multiple are, and are linked.
 * Template contains the following: at least one top-level key, DEFAULT. Other variants (e.g., for A/B testing), can be defined as 
 * other top-level keys (e.g., VARIANT_A or TREATMENT). Underneath that key comes the message definition proper, as follows:
 * { title: 'title of the message', body: 'body of the message', display: { displayDict }, responseAction: { }, responseContext: { dict }} 
 * 
 * If the top-level key is sequence, then an array should follow. The first message in the array must be the opening message, and will be 
 * marked as hasFollowingMessage. All the others will be marked as followsPriorMessage. Each element of the array will be identical to 
 * that for a single template, as above, but will also include the key, "identifier". This will be used to construct the messageIdsDict
 * that will be sent with each of the messages, so that the app or any other consumers can follow the sequences. Note that it is important
 * to keep the two identifiers distinct here: one, embedded within the template, is an identifier within the sequence of messages, the other,
 * at top level, identifies across variants.
 * 
 * @param {string} instructionId The instruction unique id, useful in persistence operations.
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
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
 * @param {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.insertMessageInstruction = async (event) => {
    try {
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        // todo : add in validation of role, but also allow for system call (e.g., boosts, but those can pass along)
        if (!userDetails || !userDetails.systemWideUserId) {
            return msgUtil.wrapHttpResponse({}, 403);
        }

        const params = extractEventBody(event);
        const creatingUserId = userDetails.systemWideUserId;
        
        const persistableObject = createPersistableObject(params, creatingUserId);
        logger('Created persistable object:', persistableObject);
        const instructionEvalResult = exports.validateMessageInstruction(persistableObject);
        logger('Message instruction evaluation result:', instructionEvalResult);
        const databaseResponse = await rdsUtil.insertMessageInstruction(persistableObject);
        logger('Message instruction insertion result:', databaseResponse);
        const message = databaseResponse[0];
        const processNowResult = await triggerTestOrProcess(message.instructionId, creatingUserId, params);

        return msgUtil.wrapHttpResponse({ message, processResult: processNowResult.result });

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return msgUtil.wrapHttpResponse({ message: err.message }, 500);
    }
};

/**
 * This function deactivates a message instruction, stopping all future notifications from message instruction.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.deactivateMessageInstruction = async (event) => {
    try {
        logger('instruction deactivator recieved:', event);
        const params = extractEventBody(event);
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
 * This function accepts an instruction id and returns the associated message instruction from the database.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.getMessageInstruction = async (event) => {
    try {
        logger('instruction retreiver recieved:', event);
        const params = extractEventBody(event); // extract event from query params
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
