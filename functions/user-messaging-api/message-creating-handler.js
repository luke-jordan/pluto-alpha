'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const rdsUtil = require('./persistence/rds.notifications');
const msgUtil = require('./msg.util');
const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });
const publisher = require('publish-common');

const STANDARD_PARAMS = [
    'user_first_name',
    'user_full_name',
    'current_balance',
    'opened_date',
    'total_interest'
];

/**
 * NOTE: This is only for custom params supplied with the message-creation event. System defined params should be left alone.
 * This function assembles the selected template and inserts relevent data where required.
 * todo : make sure this handles subparams on standard params (e.g., total_interest::since etc)
 * @param {*} template The selected template.
 * @param {*} passedParameters Extra parameters sent with the callers request. If parameters contain known proporties such as parameters.boostAmount then the associated actions are executed.
 * With regards to boost amount it is extracted from request parameters and inserted into the boost template.
 */
const placeParamsInTemplate = (template, passedParameters) => {
    if (!passedParameters || typeof passedParameters !== 'object') {
        return template;
    }

    let match = msgUtil.paramRegex.exec(template);

    let returnTemplate = template;
    while (match !== null) {
        const param = match.groups.param;
        if (Reflect.has(passedParameters, param) && STANDARD_PARAMS.indexOf(param) < 0) {
            returnTemplate = returnTemplate.replace(`#{${param}}`, passedParameters[param]);
        }
        match = msgUtil.paramRegex.exec(returnTemplate);
    }

    return returnTemplate;
};

const generateMessageFromTemplate = ({ destinationUserId, template, instruction, parameters }) => {
    const msgVariants = Object.keys(template);
    const thisVariant = msgVariants[Math.floor(Math.random() * msgVariants.length)];
    const msgTemplate = template[thisVariant];
    const messageBody = placeParamsInTemplate(msgTemplate.body, parameters); // to become a generic way of formatting variables into template.
    
    let processedStatus = null;
    const overrideStatusPassed = typeof parameters === 'object' && typeof parameters.processedStatus === 'string' && 
        parameters.processedStatus.length > 0;

    if (overrideStatusPassed) {
        processedStatus = parameters.defaultStatus;
    } else if (typeof instruction.defaultStatus === 'string' && instruction.defaultStatus.length > 0) {
        processedStatus = instruction.defaultStatus;
    } else {
        processedStatus = config.get('creating.defaultStatus');
    }
    
    const generatedMessage = {
        messageId: uuid(),
        destinationUserId,
        instructionId: instruction.instructionId,
        processedStatus,
        messageTitle: msgTemplate.title,
        messageBody,
        messageVariant: thisVariant,
        display: msgTemplate.display,
        startTime: instruction.startTime,
        endTime: instruction.endTime,
        messagePriority: instruction.messagePriority,
        followsPriorMessage: false,
        hasFollowingMessage: false
    };

    if (msgTemplate.actionToTake) {
        generatedMessage.actionContext = { actionToTake: msgTemplate.actionToTake, ...msgTemplate.actionContext };
    }

    return generatedMessage;
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
    msgsForUser.forEach((msg) => { 
        msg.messageSequence = identifierDict; 
    });
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
        logger('Constructing messages from template: ', templates.template);
        rows = userIds.map((destinationUserId) => (
            generateMessageFromTemplate({ destinationUserId, template: templates.template, instruction, parameters })));
    } else if (topLevelKey === 'sequence') {
        const templateSequence = templates.sequence;
        userIds.
            forEach((userId) => generateAndAppendMessageSequence(rows, { destinationUserId: userId, templateSequence, instruction, parameters }));        
    }
    
    logger(`created ${rows.length} user message rows. The first row looks like: ${JSON.stringify(rows[0])}`);
    
    if (!rows || rows.length === 0) {
        logger('No user messages generated, exiting');
        return { instructionId: instruction.instructionId, result: 'NO_USERS' };
    }

    const rowKeys = Object.keys(rows[0]);
    const resultOfPersistence = await rdsUtil.insertUserMessages(rows, rowKeys);

    const userLogOptions = {
        context: {
            templates,
            parameters
        }
    };

    const resultOfLogPublishing = await publisher.publishMultiUserEvent(userIds, 'MESSAGE_CREATED', userLogOptions);
    logger('Result of publishing user logs: ', resultOfLogPublishing);

    return resultOfPersistence;
};

/**
 * This function accepts an instruction detail object containing an instruction id, the destination user id, and extra parameters.
 * It uses these details to retrieve the associated instruction from persistence, assemble the user message(s), and finally persists the assembled user message(s) to RDS.
 * @param {object} instructionDetail An object containing the following properties: instructionId, destinationUserId, and parameters. These are elaborated below.
 * @property {string} instructionId The instruction id assigned during instruction creation.
 * @property {string} destinationUserId Optional. This overrides the user ids indicated in the persisted message instruction's audience ID property.
 * @property {object} parameters Required when assembling boost message. Contains details such as boostAmount, which is inserted into the boost template.
 */
const processNonRecurringInstruction = async ({ instructionId, destinationUserId, parameters }) => {
    logger('Processing instruction with ID: ', instructionId);
    const instruction = await rdsUtil.getMessageInstruction(instructionId);

    if (moment(instruction.startTime).valueOf() > moment().valueOf()) {
        return { instructionId, processResult: 'INSTRUCTION_SCHEDULED' };
    }
    
    const userIds = destinationUserId ? [destinationUserId] : await rdsUtil.getUserIds(instruction.audienceId);
    logger(`Retrieved ${userIds.length} user id(s) for instruction`);
    
    const insertionResponse = await createAndStoreMsgsForUserIds(userIds, instruction, parameters);
    if (!Array.isArray(insertionResponse) || insertionResponse.length === 0) {
        return { instructionId, insertionResponse };
    }
    
    // todo : check if there is only the one user
    const updateInstructionResult = await rdsUtil.updateInstructionState(instructionId, 'MESSAGES_GENERATED');
    logger('Update result: ', updateInstructionResult);
    
    const handlerResponse = {
        instructionId,
        instructionType: instruction.presentationType,
        numberMessagesCreated: insertionResponse.length,
        creationTimeMillis: insertionResponse[0].creationTime.valueOf(),
        instructionUpdateTime: updateInstructionResult.updatedTime
    };

    return handlerResponse;
};

/**
 * A wrapper for simple instruction processing, although can handle multiple at once
 * note: this is only called for once off or event driven messages )i.e., invokes the above)
 * @param {object} event An object containing an array of instruction detail objects. Each instruction detail object contains an instruction id, the instructions
 * destination user id, and an object of extra parameters.
 * @property {array} instructions An array of instruction identifier objects. Each instruction in the array may have the following properties:
 * @property {string} instructionId The instruction id assigned during instruction creation.
 * @property {string} destinationUserId Optional. This overrides the user ids indicated in the persisted message instruction's selectionInstruction property.
 * @property {object} parameters Required when assembling boost message. Contains details such as boostAmount, which is inserted into the boost template.tr 
 */
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

const sendRequestToRefreshAudience = async (audienceId) => {
    logger(`Sending request to refresh audience with audienceId: ${audienceId}`);
    const lambdaInvocation = {
        FunctionName: 'audience_handler',
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ operation: 'refresh', params: { audienceId } })
    };

    try {
        const result = await lambda.invoke(lambdaInvocation).promise();
        logger(`Response from request to refresh audience with audienceId: ${audienceId}. Result: ${JSON.stringify(result)}`);
        JSON.parse(result.Payload);
    } catch (error) {
        logger(`Error during request to refresh audience with audienceId: ${audienceId}. Error: ${JSON.stringify(error.message)}`);
        throw error;
    }
};

// ///////////////////////////////////////////////////////////////////////////
// ///////////////////// RECURRING MESSAGE HANDLING //////////////////////////
// ///////////////////////////////////////////////////////////////////////////


const generateRecurringMessages = async (recurringInstruction) => {
    const instructionId = recurringInstruction.instructionId;
    const audienceId = recurringInstruction.audienceId;
    await sendRequestToRefreshAudience(audienceId);

    const userIds = await rdsUtil.getUserIds(audienceId);
    const usersForMessages = await rdsUtil.filterUserIdsForRecurrence(userIds, recurringInstruction);
   
    const userMessages = await createAndStoreMsgsForUserIds(usersForMessages, recurringInstruction);
    if (!Array.isArray(userMessages) || userMessages.length === 0) {
        return { instructionId, userMessages };
    }

    if (recurringInstruction.processedStatus !== 'MESSAGES_GENERATED') {
        const updateStatusResult = await rdsUtil.updateInstructionState(instructionId, 'MESSAGES_GENERATED');
        logger('Result of updating status: ', updateStatusResult);
    }

    const updateProcessedTime = await rdsUtil.updateMessageInstruction(instructionId, { lastProcessedTime: moment().format() });

    return {
        instructionId: recurringInstruction.instructionId,
        instructionType: recurringInstruction.presentationType,
        numberMessagesCreated: userMessages.length,
        creationTimeMillis: userMessages[0].creationTime.valueOf(),
        instructionUpdateTime: updateProcessedTime.updatedTime
    };
};

/**
 * This runs on a scheduled job. It processes any recurring instructions that match the parameters.
 * Note : disabling the once off as at present that gets sent right away, and this is causing potential duplication
 */
module.exports.createFromPendingInstructions = async () => {
    try {
        // this is just going to go in and find the pending instructions and then transform them
        // first, simplest, go find once off that for some reason have not been processed yet (note: will need to avoid race condition here)
        // include within a fail-safe check that once-off messages are not regenerated when they already exist (simple count should do)
        const unprocessedOnceOffsReady = await rdsUtil.getInstructionsByType('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        logger('Would process these once off messages: ', unprocessedOnceOffsReady);

        // const onceOffPromises = unprocessedOnceOffsReady.map((instruction) => exports.createUserMessages({ instructions: [{ instructionId: instruction.instructionId }]}));
        
        // second, the more complex, find the recurring instructions, and then for each of them determine which users should see them next
        // which implies: first get the recurring instructions, then expire old messages, then add new to the queue; okay.
        const obtainRecurringMessages = await rdsUtil.getInstructionsByType('RECURRING');
        logger('Obtained recurring instruction: ', obtainRecurringMessages);

        const recurringPromises = obtainRecurringMessages.map((instruction) => generateRecurringMessages(instruction));

        // const allPromises = onceOffPromises.concat(recurringPromises);

        const processResults = await Promise.all(recurringPromises);
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
 * @param {object} event An object containing the users system wide id.
 * @property {string} systemWideUserId The users system wide id.
 */
// module.exports.syncUserMessages = async (event) => {
//     try {
//         const params = msgUtil.extractEventBody(event);
//         const systemWideUserId = params.systemWideUserId; // validation
//         logger('Got user id:', systemWideUserId);
//         const instructions = await rdsUtil.getInstructionsByType('RECURRING', ['ALL_USERS']);
//         logger('Got instructions:', instructions);
//         let rows = [];
//         for (let i = 0; i < instructions.length; i++) {
//             instructions[i].requestDetails = params;
//             const result = await assembleUserMessages(instructions[i], systemWideUserId);
//             rows = [...rows, ...result];
//         }
//         logger('Assembled user messages:', rows);
//         const rowKeys = Object.keys(rows[0]);
//         logger('Got keys:', rowKeys);
//         const insertionResponse = await rdsUtil.insertUserMessages(rows, rowKeys);
//         logger('User messages insertion resulted in:', insertionResponse);
//         return {
//             statusCode: 200,
//             body: JSON.stringify({
//                 message: insertionResponse
//             })
//         };
//     } catch (err) {
//         logger('FATAL_ERROR:', err);
//         return {
//             statusCode: 500,
//             body: JSON.stringify({ message: err.message })
//         };
//     }
// };
