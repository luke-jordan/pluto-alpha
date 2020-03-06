'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instructions');
const config = require('config');

const moment = require('moment');
const uuid = require('uuid/v4');

const rdsUtil = require('./persistence/rds.notifications');
const msgUtil = require('./msg.util');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });


const validateMessageSequence = (template) => {
    const messageSequence = template.sequence;
    logger('Evaluating sequence:', messageSequence);

    const standardSequenceProperties = ['title', 'body', 'display', 'followsPriorMessage', 'hasFollowingMessage'];

    if (!Array.isArray(messageSequence)) {
        throw new Error('Message sequence must be contained within an array');
    }

    if (messageSequence.length === 0) {
        throw new Error('Message sequence cannot be empty');
    }

    for (let index = 0; index < messageSequence.length; index++) {
        standardSequenceProperties.forEach((property) => {
            if (!Object.keys(messageSequence[index]).includes(property)) {
                throw new Error(`Missing required property in message template definition: ${property}`);
            }
        });

        if ((index === 0 && messageSequence[index].hasFollowingMessage === false) || (messageSequence.length === 1)) {
            throw new Error('Invalid message sequence definition. Single template messages cannot be disguised as message sequences.');
        }

        if (index > 0 && messageSequence[index].followsPriorMessage === false) {
            throw new Error('Invalid message sequence definintion. Sequence is non-continuous.');
        }
    }

    return true;
};

const validateMessageTemplate = (messageTemplate) => {
    logger('Validating template:', messageTemplate);
    const standardTemplateProperties = ['title', 'body', 'display'];
    const receivedTemplateProperties = Object.keys(messageTemplate.template.DEFAULT);

    standardTemplateProperties.forEach((property) => {
        if (!receivedTemplateProperties.includes(property)) {
            throw new Error(`Missing required property in message template definition: ${property}`);
        }
    });

    return true;
};

/**
 * Enforces instruction rules and ensures the message instruction is valid before it is persisted.
 * First it asserts whether all required properties are present in the instruction object. If so, then
 * condtional required properties are asserted. These are properties that are only required under certain condtions.
 * For example, if the message instruction has a recurring presentation then a recurrance instruction is required to
 * describe how frequently the notification should recur. The object properties recieved by this function are described below:
 * @param {object} instruction An instruction object. This objects properties are described below.
 * @property {string} instructionId The instruction unique id, useful in persistence operations.
 * @property {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @property {boolean} active Indicates whether the message is active or not.
 * @property {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @property {object} templates Required. Message instruction must include at least one template, ie, the notification message to be displayed
 * @property {string} audienceId Required when audience type is either INDIVIDUAL or GROUP. Specifies the ID of the audience for the message. 
 * @property {object} recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @property {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @property {object} responseContext An object that includes details such as the boost ID.
 * @property {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @property {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @property {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
 */
module.exports.validateMessageInstruction = (instruction) => {
    logger('Evaluating instruction:', instruction);
    const requiredProperties = config.get('instruction.requiredProperties');
    for (let i = 0; i < requiredProperties.length; i += 1) {
        if (!instruction[requiredProperties[i]]) {
            throw new Error(`Missing required property value: ${requiredProperties[i]}`);
        }
    }

    if (!instruction.templates.sequence && !instruction.templates.template) {
        throw new Error('Templates must define either a sequence or a single template.');
    }
    
    const templateType = Object.keys(instruction.templates)[0] === 'template' ? 'template' : 'sequence';
    logger('Processing template of type:', templateType);
    const templateValidationResult = templateType === 'template' ? validateMessageTemplate(instruction.templates) : validateMessageSequence(instruction.templates); 
    logger('Template validation result:', templateValidationResult);

    switch (true) {
        case instruction.presentationType === 'RECURRING' && !instruction.recurrenceParameters:
            throw new Error('recurrenceParameters is required where presentationType is set to RECURRING.');
        case instruction.audienceType === 'INDIVIDUAL' && !instruction.audienceId:
            throw new Error('Audience ID required on indivdual notification.');
        case instruction.audienceType === 'GROUP' && !instruction.audienceId:
            throw new Error('Audience ID required on group notification.');
        case instruction.presentationType === 'EVENT_DRIVEN' && !instruction.eventTypeCategory:
            throw new Error('Instructions for event driven must specify the event type');
        default:
            logger('Validation passed for message instruction');
            return true;
    }
};

/** todo : validate templates
 * This function takes the instruction passed by the caller, assigns it an instruction id, activates it,
 * and assigns default values where none are provided by the input object.
 * @param {object} instruction An instruction object. Its properties are detailed below.
 * @param {string} creatingUserId The system wide id of the user creating the instruction. 
 * @property {string} instruction.presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @property {string} instruction.audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @property {string} instruction.defaultTemplate Required when otherTemplates is null. Templates describe the message to be shown in the notification.
 * @property {string} instruction.otherTemplates Required when defaultTemplate is null.
 * @property {string} instruction.audienceId Required when audience type is either INDIVIDUAL or GROUP. 
 * @property {object} instruction.recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @property {string} instruction.eventTypeCategory The event type and category for this instruction, controlled by caller's logic (e.g., REFERRAL::REDEEMED::REFERRER);
 */
const createPersistableObject = (instruction, creatingUserId) => {
    
    const instructionId = uuid();
    const startTime = instruction.startTime || moment().format();
    const endTime = instruction.endTime || moment().add(500, 'years').format();
    logger('Received message priority: ', instruction.messagePriority);
    const messagePriority = instruction.messagePriority || 0;

    const presentationType = instruction.presentationType;
    const processedStatus = presentationType === 'ONCE_OFF' ? 'READY_FOR_GENERATING' : 'CREATED';

    const flags = presentationType === 'EVENT_DRIVEN' ? [`EVENT_TYPE::${instruction.eventTypeCategory}`] : [];
    logger('Object created with flags: ', flags);

    logger('Message instruction templates: ', JSON.stringify(instruction.templates));

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
        audienceId: instruction.audienceId,
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
    const isScheduled = moment(params.startTime).valueOf() > moment().valueOf();
    logger(`Is message scheduled for future delivery?: ${isScheduled}`);
    if (params.presentationType === 'ONCE_OFF' && !holdOffInstructed && !isScheduled) {
        const lambdaPaylod = { instructions: [{ instructionId }]};
        const fireResult = await lambda.invoke(msgUtil.lambdaInvocation(createMessagesFunction, lambdaPaylod)).promise();
        logger('Fired off process instruction: ', fireResult);
        return { result: 'FIRED_INSTRUCT' };
    }

    return { result: 'INSTRUCT_STORED' };
};

/**
 * This function accepts a new instruction, validates the instruction, then persists it. Depending on the instruction, either
 * the whole or a subset of properties described below may be provided as input. 
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
 * @param {object} event An object containing the request context and a body containing the instruction to be persisted.
 * @property {object} requestContext  An object containing the callers id, role, and permissions. The event will not be processed without a valid request context.
 * The properties listed below belong to the events body.
 * @property {string} instructionId The instructions unique id, useful in persistence operations.
 * @property {string} presentationType Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN.
 * @property {boolean} active Indicates whether the message is active or not.
 * @property {string} audienceType Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS.
 * @property {string} template Provides message templates, as described above
 * @property {string} audienceId Required when audience type is either INDIVIDUAL or GROUP. 
 * @property {object} recurrenceParameters Required when presentation type is RECURRING. Describes details like recurrence frequency, etc.
 * @property {string} responseAction Valid values include VIEW_HISTORY and INITIATE_GAME.
 * @property {object} responseContext An object that includes details such as the boost ID.
 * @property {string} startTime A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now.
 * @property {string} endTime A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time.
 * @property {string} lastProcessedTime This property is updated eah time the message instruction is processed.
 * @property {number} messagePriority An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller).
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
 * @param {object} event An object containing the request context, and an instruction id and update object in the body. Properties of the event body are described below. 
 * @property {string} instructionId The message instruction ID assigned during instruction creation.
 * @property {object} updateValues Key-values of properties to update (e.g., { active: false })
 */
module.exports.updateInstruction = async (event) => {
    try {
        logger('Update message instruction received');
        const userDetails = msgUtil.extractUserDetails(event);
        if (!msgUtil.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return msgUtil.unauthorizedResponse;
        }

        const params = msgUtil.extractEventBody(event);
        logger('Instruction update received, with paramaters:', params);
        const instructionId = params.instructionId;
        const updateValues = params.updateValues;
        const endTime = Reflect.has(params, 'endTime') ? params.endTime : null;
        const databaseResponse = await rdsUtil.updateMessageInstruction(instructionId, updateValues);
        if (typeof updateValues.active === 'boolean' && !updateValues.active) {
            await rdsUtil.alterInstructionMessageStates(instructionId, ['CREATED', 'READY_FOR_SENDING'], 'DEACTIVATED', endTime);
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
 * @param {object} event An object containing the id of the instruction to be retrieved.
 * @property {string} instructionId The message instruction ID assigned during instruction creation.
 */
module.exports.getMessageInstruction = async (event) => {
    try {
        logger('Fetching message instruction');
        const params = msgUtil.extractEventBody(event);
        logger('Parameters for instruction fetch: ', params);
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
 * @param {string} event An object containing the request context and a body object containing a boolean property which indicates whether to include pending instructions in the resulting listing. 
 * @property {Object} requestContext An object containing the callers id, role, and permissions. The event will not be processed without a valid request context.
 * @property {boolean} includeStillDelivering A boolean value indicating whether to include messages that are still deliverig in the list of active messages.
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
