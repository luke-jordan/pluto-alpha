'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler');
const config = require('config');
const uuid = require('uuid/v4');

const rdsUtil = require('./persistence/rds.notifications');

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;
const extractUserDetails = (event) => event.requestContext ? event.requestContext.authorizer : null;

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
 * NOTE: This is only for custom params supplied with the message-creation event. System defined params should be left alone.
 * This function assembles the selected template and inserts relevent data where required.
 * todo : make sure this handles subparams on standard params (e.g., total_interest::since etc)
 * @param {*} template The selected template.
 * @param {*} passedParameters Extra parameters sent with the callers request. If parameters contain known proporties such as parameters.boostAmount then the associated are executed.
 * With regards to boost amount it is extracted from request parameters and inserted into the boost template.
 */
const assembleTemplate = (template, passedParameters) => {
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

const generateMessageFromTemplate = ({ destinationUserId, template, instruction, requestDetails }) => {
    const msgVariants = Object.keys(template);
    const thisVariant = msgVariants[Math.floor(Math.random() * msgVariants.length)];
    const msgTemplate = template[thisVariant];
    const messageBody = assembleTemplate(msgTemplate.body, requestDetails); // to become a generic way of formatting variables into template.
    const actionContext = msgTemplate.actionToTake ? { actionToTake: msgTemplate.actionToTake, ...msgTemplate.actionContext } : undefined;
    
    let processedStatus = null;
    const overrideStatusPassed = typeof requestDetails === 'object' && typeof requestDetails.processedStatus === 'string' && 
        requestDetails.processedStatus.length > 0;

    if (overrideStatusPassed) {
        processedStatus = requestDetails.defaultStatus;
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

const generateAndAddMessageSequence = (rows, { destinationUserId, templateSequence, instruction, requestDetails }) => {
    const msgsForUser = [];
    const identifierDict = { };
    templateSequence.forEach((templateDef, idx) => {
        const template = JSON.parse(JSON.stringify(templateDef));
        Reflect.deleteProperty(template, 'identifier');
        
        const userMessage = generateMessageFromTemplate({ 
            destinationUserId, template, instruction, requestDetails 
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

/**
 * This function takes a message instruction and returns an array of user message rows. Instruction properties are as follows:
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
    const selectionInstruction = instruction.selectionInstruction || null;
    const userIds = destinationUserId ? [ destinationUserId ] : await rdsUtil.getUserIds(selectionInstruction);
    logger(`Retrieved ${userIds.length} user id(s) for instruction`);
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
        logger('No users match this selection criteria, exiting');
        return [];
    }

    const templates = instruction.templates;
    if (typeof templates !== 'object' || Object.keys(templates).length !== 1) {
        throw new Error('Malformed template instruction: ', instruction.templates);
    }
    const requestDetails = instruction.requestDetails ? instruction.requestDetails.parameters : undefined;

    let rows = [];
    
    const topLevelKey = Object.keys(templates)[0];
    if (topLevelKey === 'template') {
        rows = userIds.map((destinationUserId) => (generateMessageFromTemplate({ 
            destinationUserId,
            template: templates.template,
            instruction,
            requestDetails
         })));
    } else if (topLevelKey === 'sequence') {
        logger('Implement sequences');
        const templateSequence = templates.sequence;
        // alternate is home grown flat map using eg reduce & concat, but that will be _very_ inefficient at high numbers, so might as well
        userIds.forEach((userId) => generateAndAddMessageSequence(rows,
            { destinationUserId: userId, templateSequence, instruction, requestDetails }));        
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
        const insertionResponse = await rdsUtil.insertUserMessages(rows, rowKeys);
        
        const handlerResponse = {
            numberMessagesCreated: insertionResponse.length,
            creationTimeMillis: insertionResponse[0].creationTime.valueOf()
        };

        return {
            statusCode: 200,
            body: JSON.stringify(handlerResponse)
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
