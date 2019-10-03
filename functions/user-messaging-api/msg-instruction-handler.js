'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');

const moment = require('moment');
const uuid = require('uuid/v4');

const rdsUtil = require('./persistence/rds.notifications');
const msgUtil = require('./msg.util');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

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
 * @param {object} recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @param {object} responseContext An object that includes details such as the boost ID.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.validateMessageInstruction = (instruction) => {
    const requiredProperties = config.get('instruction.requiredProperties');
    for (let i = 0; i < requiredProperties.length; i += 1) {
        if (!instruction[requiredProperties[i]]) {
            throw new Error(`Missing required property value: ${requiredProperties[i]}`);
        }
    }

    switch (true) {
        case instruction.presentationType === 'RECURRING' && !instruction.recurrenceParameters:
            throw new Error('recurrenceParameters is required where presentationType is set to RECURRING.');
        case instruction.audienceType === 'INDIVIDUAL' && !instruction.selectionInstruction:
            throw new Error('selectionInstruction required on indivdual notification.');
        case instruction.audienceType === 'GROUP' && !instruction.selectionInstruction:
            throw new Error('selectionInstruction required on group notification.');
        case !instruction.templates.sequence && !instruction.templates.template:
            throw new Error('Templates must define either a sequence or a single template.');
        case instruction.presentationType === 'EVENT_DRIVEN' && !instruction.eventTypeCategory:
            throw new Error('Instructions for event driven must specify the event type');
        default:
            logger('Validation passed for message instruction'); 
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
 * @param {object} recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} eventTypeCategory The event type and category for this instruction, controlled by caller's logic (e.g., REFERRAL::REDEEMED::REFERRER);
 */
const createPersistableObject = (instruction, creatingUserId) => {
    
    const instructionId = uuid();
    const startTime = instruction.startTime || moment().format();
    const endTime = instruction.endTime || moment().add(500, 'years').format();
    logger('Received message priority: ', instruction.messagePriority);
    const messagePriority = instruction.messagePriority || 0;

    const presentationType = instruction.presentationType;
    const processedStatus = presentationType === 'ONCE_OFF' ? 'READY_FOR_GENERATING' : 'CREATED';

    const flags = presentationType === 'EVENT_DRIVEN' ? [instruction.eventTypeCategory] : [];
    logger('Object created with flags: ', flags);

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
        recurrenceParameters: instruction.recurrenceParameters,
        lastProcessedTime: moment().format(),
        messagePriority,
        flags
    };
};

const triggerTestOrProcess = async (instructionId, creatingUserId, params) => {
    const createMessagesFunction = config.get('lambdas.generateUserMessages');

    // first, we check if there should be a test first. if so, we process for that user.
    if (typeof params.fireTestMessage === 'boolean' && params.fireTestMessage) {
        const instructionPayload = { instructions: [{ instructionId, destinationUserId: creatingUserId }] };
        const testRes = await lambda.invoke(msgUtil.lambdaInvocation(createMessagesFunction, instructionPayload)).promise();
        logger('Fired off test result: ', testRes);
        return { result: 'FIRED_TEST' };
    }

    // second, if there was no test instruction, then unless we have an explicit 'hold', we create the messages for 
    // once off messages right away (on assumption they should go out)
    const holdOffInstructed = typeof params.holdFire === 'boolean' && params.holdFire;
    logger(`Fire off now? Presentation type: ${params.presentationType} and hold off instructed ? : ${holdOffInstructed}`);
    if (params.presentationType === 'ONCE_OFF' && !holdOffInstructed) {
        const lambdaPaylod = { instructions: [{ instructionId }]};
        const fireResult = await lambda.invoke(msgUtil.lambdaInvocation(createMessagesFunction, lambdaPaylod)).promise();
        logger('Fired off process instruction: ', fireResult);
        return { result: 'FIRED_INSTRUCT' };
    }

    return { result: 'INSTRUCT_STORED' };
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
 * @param {string} instructionId The instructions unique id, useful in persistence operations.
 * @param {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @param {boolean} active Indicates whether the message is active or not.
 * @param {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @param {string} template Provides message templates, as described above
 * @param {object} selectionInstruction Required when audience type is either INDIVIDUAL or GROUP. 
 * @param {object} recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @param {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @param {object} responseContext An object that includes details such as the boost ID.
 * @param {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @param {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @param {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @param {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.insertMessageInstruction = async (event) => {
    try {
        const isHttpRequest = Reflect.has(event, 'httpMethod'); // todo : tighten this in time
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        logger(`Is HTTP request? : ${isHttpRequest} and user details: ${userDetails}`);
        // todo : add in validation of role, but also allow for system call (e.g., boosts, but those can pass along)
        if (isHttpRequest && !msgUtil.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return msgUtil.unauthorizedResponse;
        }

        const params = msgUtil.extractEventBody(event);
        const creatingUserId = isHttpRequest ? userDetails.systemWideUserId : params.creatingUserId;

        const instructionEvalResult = exports.validateMessageInstruction(params);
        logger('Message instruction evaluation result:', instructionEvalResult);
        const persistableObject = createPersistableObject(params, creatingUserId);
        logger('Created persistable object:', persistableObject);
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
 * This function can be used to update various aspects of a message. Note that if it 
 * deactivates the message instruction, that will stop all future notifications from message instruction,
 * and removes existing ones from the fetch queue.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 * @param {object} updateValues Key-values of properties to update (e.g., { active: false })
 */
module.exports.updateInstruction = async (event) => {
    try {
        logger('Instruction update recieved:', event);
        const userDetails = msgUtil.extractUserDetails(event);
        if (!msgUtil.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return msgUtil.unauthorizedResponse;
        }

        const params = msgUtil.extractEventBody(event);
        const instructionId = params.instructionId;
        const updateValues = params.updateValues;
        const databaseResponse = await rdsUtil.updateMessageInstruction(instructionId, updateValues);
        if (typeof updateValues.active === 'boolean' && !updateValues.active) {
            await rdsUtil.alterInstructionMessageStates(instructionId, ['CREATED', 'READY_FOR_SENDING'], 'DEACTIVATED');
        }
        logger('Result of instruction deactivation:', databaseResponse);
        return msgUtil.wrapHttpResponse(databaseResponse);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return msgUtil.wrapHttpResponse({ message: err.message }, 500);
    }
};

/**
 * This function accepts an instruction id and returns the associated message instruction from the database.
 * @param {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.getMessageInstruction = async (event) => {
    try {
        logger('instruction retreiver recieved:', event);
        const params = msgUtil.extractEventBody(event);
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

/** 
 * This function (which will only be available to users with the right roles/permissions) will list currently active messages,
 * i.e., those that are marked as active, and, optionally, those that still have messages unread by users
 */
module.exports.listActiveMessages = async (event) => {
    try {
        const userDetails = msgUtil.extractUserDetails(event);
        if (!msgUtil.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return msgUtil.unauthorizedResponse;
        }

        const params = msgUtil.extractEventBody(event);
        const includeStillDelivering = params.includeStillDelivering || false;
        const activeMessages = await rdsUtil.getCurrentInstructions(includeStillDelivering);
        logger('Active instructions: ', activeMessages);

        return msgUtil.wrapHttpResponse(activeMessages);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return msgUtil.wrapHttpResponse(err.message, 500);
    }
};
