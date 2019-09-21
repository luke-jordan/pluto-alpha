'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const rdsUtil = require('./persistence/rds.notifications');
const msgUtil = require('./msg.util');

// todo : stick in a common file
const paramRegex = /#{([^}]*)}/g;
const STANDARD_PARAMS = [
    'user_first_name',
    'user_full_name',
    'current_balance',
    'opened_date',
    'total_interest'
];

/**
 * This sequences of functions take a message instruction and returns an array of user message rows. Instruction properties are as follows:
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

/**
 * NOTE: This is only for custom params supplied with the message-creation event. System defined params should be left alone.
 * This function assembles the selected template and inserts relevent data where required.
 * todo : make sure this handles subparams on standard params (e.g., total_interest::since etc)
 * @param {*} template The selected template.
 * @param {*} passedParameters Extra parameters sent with the callers request. If parameters contain known proporties such as parameters.boostAmount then the associated are executed.
 * With regards to boost amount it is extracted from request parameters and inserted into the boost template.
 */
const placeParamsInTemplate = (template, passedParameters) => {
    if (!passedParameters || typeof passedParameters !== 'object') {
        return template;
    }

    let match = paramRegex.exec(template);

    // todo : make less ugly, possibly
    while (match !== null) {
        const param = match[1];
        if (Reflect.has(passedParameters, param) && STANDARD_PARAMS.indexOf(param) === -1) {
            template = template.replace(`#{${param}}`, passedParameters[param]);
        }
        match = paramRegex.exec(template);
    }

    return template;
};

const generateMessageFromTemplate = ({ destinationUserId, template, instruction, parameters }) => {
    const msgVariants = Object.keys(template);
    const thisVariant = msgVariants[Math.floor(Math.random() * msgVariants.length)];
    const msgTemplate = template[thisVariant];
    const messageBody = placeParamsInTemplate(msgTemplate.body, parameters); // to become a generic way of formatting variables into template.
    const actionContext = msgTemplate.actionToTake ? { actionToTake: msgTemplate.actionToTake, ...msgTemplate.actionContext } : undefined;
    
    let processedStatus = null;
    const overrideStatusPassed = typeof parameters === 'object' && typeof parameters.processedStatus === 'string' && 
        parameters.processedStatus.length > 0;

    if (overrideStatusPassed) {
        processedStatus = parameters.defaultStatus;
    } else if (typeof instruction.defaultStatus === 'string' && instruction.defaultStatus.length > 0) {
        processedStatus = instruction.defaultStatus;
    } else  {
        processedStatus = config.get('creating.defaultStatus');
    }
    
    return {
        messageId: uuid(),
        destinationUserId,
        instructionId: instruction.instructionId,
        processedStatus,
        messageTitle: msgTemplate.title,
        messageBody,
        actionContext,
        messageVariant: thisVariant,
        display: msgTemplate.display,
        startTime: instruction.startTime,
        endTime: instruction.endTime,
        presentationType: instruction.presentationType,
        messagePriority: instruction.messagePriority,
        followsPriorMessage: false,
        hasFollowingMessage: false
    };
};

const generateAndAppendMessageSequence = (rows, { destinationUserId, templateSequence, instruction, parameters }) => {
    const msgsForUser = [];
    const identifierDict = { };
    templateSequence.forEach((templateDef, idx) => {
        const template = JSON.parse(JSON.stringify(templateDef));
        Reflect.deleteProperty(template, 'identifier');
        
        const userMessage = generateMessageFromTemplate({ 
            destinationUserId, template, instruction, parameters
        });
        
        if (idx === 0) {
            userMessage.hasFollowingMessage = true;
        } else {
            userMessage.followsPriorMessage = true;
        }
        
        identifierDict[templateDef.identifier] = userMessage.messageId;
        msgsForUser.push(userMessage);
    });
    // logger('Identifier dict: ', identifierDict);
    msgsForUser.forEach((msg) => msg.messageSequence = identifierDict);
    rows.push(...msgsForUser);
};

const createAndStoreMsgsForUserIds = async (userIds, instruction, parameters) => {
    if (!Array.isArray(userIds) || userIds.length === 0) {
        logger('No users match this selection criteria, exiting');
        return [];
    }

    const templates = instruction.templates;
    if (typeof templates !== 'object' || Object.keys(templates).length !== 1) {
        throw new Error('Malformed template instruction: ', instruction.templates);
    }
    
    let rows = [];
    
    const topLevelKey = Object.keys(templates)[0];

    // i.e., if the instruction holds a sequence of messages (like in a boost offer), generate all of those for each user, else just the one
    if (topLevelKey === 'template') {
        rows = userIds.map((destinationUserId) => (
            generateMessageFromTemplate({ destinationUserId, template: templates.template, instruction, parameters })));
    } else if (topLevelKey === 'sequence') {
        const templateSequence = templates.sequence;
        userIds.forEach((userId) => 
            generateAndAppendMessageSequence(rows, { destinationUserId: userId, templateSequence, instruction, parameters }));        
    }
    
    logger(`created ${rows.length} user message rows. The first row looks like: ${JSON.stringify(rows[0])}`);
    if (!rows || rows.length === 0) {
        logger('No user messages generated, exiting');
        return { instructionId, result: 'NO_USERS' };
    }

    const rowKeys = Object.keys(rows[0]);
    return rdsUtil.insertUserMessages(rows, rowKeys);
}

/**
 * This function accepts an instruction id, retrieves the associated instruction from persistence, assembles the user message, and finally
 * persists the assembled user message to RDS. The minimum required parameter that must be passed to this function is the instruction. Without
 * it the sun does not shine. Other properties may be included in the parameters, such as destinationId
 * @param {string} instructionId The instruction id assigned during instruction creation.
 * @param {string} destinationUserId Optional. This overrides the user ids indicated in the persisted message instruction's selectionInstruction property.
 * @param {object} parameters Required when assembling boost message. Contains details such as boostAmount, which is inserted into the boost template.
 * @param {boolean} triggerBalanceFetch Required on boost message assembly. Indicates whether to include the users new balance in the boost message.
 */
const processNonRecurringInstruction = async ({ instructionId, destinationUserId, parameters }) => {
    logger('Processing instruction with ID: ', instructionId);
    const instruction = await rdsUtil.getMessageInstruction(instructionId);
    
    const selectionInstruction = instruction.selectionInstruction || null;
    const userIds = destinationUserId ? [ destinationUserId ] : await rdsUtil.getUserIds(selectionInstruction);
    logger(`Retrieved ${userIds.length} user id(s) for instruction`);
    
    const insertionResponse = await createAndStoreMsgsForUserIds(userIds, instruction, parameters);
    if (!Array.isArray(insertionResponse)) {
        return { instructionId, insertionResponse };
    }
    
    // todo : check if there is only the one user
    const updateInstructionResult = await rdsUtil.updateInstructionState(instructionId, 'MESSAGES_CREATED');
    logger('Update result: ', updateInstructionResult);
    
    const handlerResponse = {
        instructionId,
        instructionType: instruction.presentationType,
        numberMessagesCreated: insertionResponse.length,
        creationTimeMillis: insertionResponse[0].creationTime.valueOf(),
        instructionUpdateTime: updateInstructionResult.updatedTime
    };

    return handlerResponse;
}

// a wrapper for simple instruction processing, although can handle multiple at once
// note: this is only called for once off or event driven messages )i.e., invokes the above)
module.exports.createUserMessages = async (event) => {
    try {
        const createDetails = msgUtil.extractEventBody(event);
        logger('Receieved params:', createDetails);
        const instructionsToProcess = createDetails.instructions;
        if (!Array.isArray(instructionsToProcess) || instructionsToProcess.length === 0) {
            return { statusCode: 202, message: 'No instructions provided' };
        }
        const processPromises = instructionsToProcess.map((instruction) => processNonRecurringInstruction(instruction));
        const processResults = await Promise.all(processPromises);
        return processResults;
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { message: err.message };
    }
};

/////////////////////////////////////////////////////////////////////////////
/////////////////////// RECURRING MESSAGE HANDLING //////////////////////////
/////////////////////////////////////////////////////////////////////////////


const generateRecurringMessages = async (recurringInstruction) => {
    const instructionId = recurringInstruction.instructionId;
    
    const userIds = await rdsUtil.getUserIds(recurringInstruction.selectionInstruction);
    const usersForMessages = await rdsUtil.filterUserIdsForRecurrence(userIds, recurringInstruction);
    
    const userMessages = await createAndStoreMsgsForUserIds(usersForMessages, recurringInstruction);
    if (!Array.isArray(userMessages) || userMessages.length === 0) {
        return { instructionId, userMessages };
    }

    if (recurringInstruction.processedStatus !== 'MESSAGES_CREATED') {
        const updateStatusResult = await rdsUtil.updateInstructionState(instructionId, 'MESSAGES_CREATED');
        logger('Result of updating status: ', updateStatusResult);
    }

    const updateProcessedTime = await rdsUtil.updateMessageInstruction(instructionId, 'last_processed_time', moment().format());

    return {
        instructionId: recurringInstruction.instructionId,
        instructionType: recurringInstruction.presentationType,
        numberMessagesCreated: userMessages.length,
        creationTimeMillis: userMessages[0].creationTime.valueOf(),
        instructionUpdateTime: updateProcessedTime.updatedTime
    };
};

/**
 * This runs on a scheduled job. It processes any once off instructions that have not been processed yet. Otherwise, it 
 */
module.exports.createFromPendingInstructions = async () => {
    try {
        // this is just going to go in and find the pending instructions and then transform them
        // first, simplest, go find once off that for some reason have not been processed yet (note: will need to avoid race condition here)
        // include within a fail-safe check that once-off messages are not regenerated when they already exist (simple count should do)
        const unprocessedOnceOffsReady = await rdsUtil.getInstructionsByType('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        const onceOffPromises = unprocessedOnceOffsReady.map((instruction) => exports.createUserMessages({ instructionId: instruction.instructionId }));
        
        // second, the more complex, find the recurring instructions, and then for each of them determine which users should see them next
        // which implies: first get the recurring instructions, then expire old messages, then add new to the queue; okay.
        const obtainRecurringMessages = await rdsUtil.getInstructionsByType('RECURRING');
        logger('Obtained recurring instruction: ', obtainRecurringMessages);

        const recurringPromises = obtainRecurringMessages.map((instruction) => generateRecurringMessages(instruction));

        const allPromises = onceOffPromises.concat(recurringPromises);

        const processResults = await Promise.all(allPromises);
        logger('Results of message processing: ', processResults);

        const messagesProcessed = processResults.length;

        return { messagesProcessed, processResults };
    } catch (err) {
        logger('FATAL_ERROR', err);
        return { result: 'ERROR', message: err.message };
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
        const params = msgUtil.extractEventBody(event);
        const systemWideUserId = params.systemWideUserId; // validation
        logger('Got user id:', systemWideUserId);
        const instructions = await rdsUtil.getInstructionsByType('RECURRING', ['ALL_USERS']);
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

