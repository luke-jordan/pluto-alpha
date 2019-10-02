'use strict';

const logger = require('debug')('jupiter:boosts:create');
const config = require('config');
const moment = require('moment');
const status = require('statuses');
const stringify = require('json-stable-stringify');

const util = require('./boost.util');
const persistence = require('./persistence/rds.boost');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region' )});

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;

const ALLOWABLE_ORDINARY_USER = ['REFERRAL::USER_CODE_USED'];
const STANDARD_GAME_ACTIONS = {
    'OFFERED': { action: 'ADD_CASH' },
    'UNLOCKED': { action: 'PLAY_GAME' },
    'INSTRUCTION': { action: 'PLAY_GAME' },
    'REDEEMED': { action: 'DONE' },
    'FAILURE': { action: 'DONE' }
};

const handleError = (err) => {
    logger('FATAL_ERROR: ', err);
    return { statusCode: status('Internal Server Error'), body: JSON.stringify(err.message) };
};
const obtainStdAction = (msgKey) => Reflect.has(STANDARD_GAME_ACTIONS, msgKey) ? STANDARD_GAME_ACTIONS[msgKey].action : 'ADD_CASH'; 

const convertParamsToRedemptionCondition = (gameParams) => {
    const conditions = [];
    switch (gameParams.gameType) {
        case 'CHASE_ARROW':
        case 'TAP_SCREEN':
            conditions.push('taps_submitted');
            const timeLimitMillis = gameParams.timeLimitSeconds * 1000;
            if (gameParams.winningThreshold) {
                conditions.push(`number_taps_greater_than #{${gameParams.winningThreshold}::${timeLimitMillis}}`)
            }
            if (gameParams.numberWinners) {
                conditions.push(`number_taps_in_first_N #{${gameParams.numberWinners}::${timeLimitMillis}}`);
            }
            break;
        default:
            logger('ERROR! Unimplemented game');
            break;
    }
    return conditions;
} 

const extractStatusConditions = (gameParams) => {
    // all games start with this
    const statusConditions = {};
    statusConditions['OFFERED'] = ['message_instruction_created'];
    statusConditions['UNLOCKED'] = [gameParams.entryCondition];
    statusConditions['REDEEMED'] = convertParamsToRedemptionCondition(gameParams);
    return statusConditions;
};

// finds and uses existing message templates based on provided flags
const obtainDefaultMessageInstructions = async (messageInstructionFlags) => {
    logger('Alright, got some message flags, we can go find the instructions, from: ', messageInstructionFlags);
    
    const messageInstructions = [];
    // cycle through the keys, which will represent the statuses (um, clean this up a lot, and especially parallelize it)
    const statuses = Object.keys(messageInstructionFlags);
    logger('Have statuses: ', statuses);
    for (let status of statuses) {
        const messageFlags = messageInstructionFlags[status];
        logger('Message flags: ', messageFlags);
        for (let flagDef of messageFlags) {
            const { accountId, msgInstructionFlag } = flagDef;
            const msgInstructionId = await persistence.findMsgInstructionByFlag(msgInstructionFlag);
            logger('Result of flag hunt: ', msgInstructionId);
            if (typeof msgInstructionId === 'string') {
                messageInstructions.push({ accountId, status, msgInstructionId });
            }
        }
    }
    
    logger('Finished hunting by flag, have result: ', messageInstructions);
    return messageInstructions;
};

/**
 * Assembles instruction payloads from messages created by admin user while they create the boost.
 * This depends on a message definition of the form:
 * { presentationType, isMessageSequence, msgTemplates }
 * msgTemplates must be a dict with keys as boost statuses and objects a standard message template (see messages docs for format)
 * @param {*} boostParams 
 * @param {*} messageDefinition 
 * @param {*} gameParams 
 */
const createMsgInstructionFromDefinition = (messageDefinition, boostParams, gameParams) => {
    // first, assemble the basic parameters. note: boost status is not used 
    logger('Assembling message instruction from: ', messageDefinition);

    const msgPayload = {
        creatingUserId: boostParams.creatingUserId,
        boostStatus: messageDefinition.boostStatus,
        presentationType: messageDefinition.presentationType,
        audienceType: boostParams.audienceType,
        endTime: boostParams.boostEndTime.format(),
        selectionInstruction: `match_other from #{{"entityType": "boost", "entityId": "${boostParams.boostId}"}}`
    };
    logger('Base of message payload: ', msgPayload);
        
    // then, if the message defines a sequence, assemble those templates together
    if (messageDefinition.isMessageSequence) {
        const actionContext = {
            boostId: boostParams.boostId,
            sequenceExpiryTimeMillis: boostParams.boostEndTime.valueOf(),
            gameParams
        };

        // message definitions are templated by boost status
        const msgTemplates = messageDefinition.templates;
        const sequenceOfMessages = Object.keys(msgTemplates).map((boostStatus) => {
            const msgTemplate = msgTemplates[boostStatus];
            msgTemplate.actionToTake = msgTemplate.actionToTake || obtainStdAction(boostStatus);
            msgTemplate.actionContext = actionContext;
            return { 'DEFAULT': msgTemplate, identifier: boostStatus }
        });

        msgPayload.templates = { 
            sequence: sequenceOfMessages
        };
    
    // if it's not a sequence, just put the template in the expected order
    } else {
        const template = messageDefinition.template;
        template.actionContext = { ...template.actionContext, boostId: boostParams.boostId };
        msgPayload.actionToTake = template.actionToTake;
        msgPayload.templates = { template: { 'DEFAULT': template }};
    }

    return msgPayload;
};

const assembleMsgLamdbaInvocation = async (msgPayload) => {
    const messageInstructInvocation = {
        FunctionName: config.get('lambdas.messageInstruct'),
        InvocationType: 'RequestResponse',
        Payload: stringify(msgPayload) 
    };

    const resultOfMsgCreation = await lambda.invoke(messageInstructInvocation).promise();
    logger('Result of message invocation: ', resultOfMsgCreation);

    const resultPayload = JSON.parse(resultOfMsgCreation.Payload);
    const resultBody = JSON.parse(resultPayload.body);
    logger('Result body on invocation: ', resultBody);

    return { accountId: 'ALL', status: msgPayload.boostStatus, msgInstructionId: resultBody.message.instructionId }
};

/**
 * The primary method here. Creates a boost and sets various other methods into action
 * Note, there are three ways boosts can have their messages assigned:
 * (1) Include an explicit set of redemption message instructions ('redemptionMsgInstructions')
 * (2) Include a set of message instruction flags (i.e., ways to find defaults), as a dict with top-level key being the status ('messageInstructionFlags')
 * (3) Include the message definitions in messages to create ('messagesToCreate')
 * 
 * Note (1): There is a distinction between (i) a message that is presented in a linked sequence, as in a game, and (ii) multiple messages
 * that are independent of each other, e.g., a push notification and an in-app card. The first case comes in a single message definition
 * because the messages must be sent to the app together; the second comes in multiple definitions.
 * 
 * Note (2): If multiple of the types above are passed, (3) will override the others (as it is called last)
 * Also note that if none are provided the boost will have no message and just hang in the ether
 */
module.exports.createBoost = async (event) => {
    if (!event) {
        logger('Test run on lambda, exiting');
        return { statusCode: 400 };
    }

    const params = event;
    // logger('Received boost instruction event: ', params);

    // todo : extensive validation
    const boostType = params.boostTypeCategory.split('::')[0];
    const boostCategory = params.boostTypeCategory.split('::')[1];

    logger(`Boost type: ${boostType} and category: ${boostCategory}`);

    const boostAmountDetails = params.boostAmountOffered.split('::');
    logger('Boost amount details: ', boostAmountDetails);
    
    let boostBudget = 0;
    if (typeof params.boostBudget === 'number') {
        boostBudget = params.boostBudget;
    } else if (typeof params.boostBudget === 'string') {
        const boostBudgetParams = params.boostBudget.split('::');
        if (boostAmountDetails[1] !== boostBudgetParams[1] || boostAmountDetails[2] !== boostBudgetParams[2]) {
            return util.wrapHttpResponse('Error! Budget must be in same unit & currency as amount', 400);
        }
        boostBudget = parseInt(boostBudgetParams[0], 10);
    }

    // start now if nothing provided
    const boostStartTime = params.startTimeMillis ? moment(params.startTimeMillis) : moment();
    const boostEndTime = params.endTimeMillis ? moment(params.endTimeMillis) : moment().add(config.get('time.defaultEnd.number'), config.get('time.defaultEnd.unit'));

    logger(`Boost start time: ${boostStartTime.format()} and end time: ${boostEndTime.format()}`);
    logger('Boost source: ', params.boostSource);
    logger('Creating user: ', params.creatingUserId);

    // todo : more validation & error throwing here, e.g., if neither exists
    logger('Game params: ', params.gameParams);
    if (!params.statusConditions && params.gameParams) {
        params.statusConditions = extractStatusConditions(params.gameParams);
    }

    let messageInstructionIds = [];
    // many boosts will just do it this way, or else will use the more complex one below
    if (params.redemptionMsgInstructions) {
        messageInstructionIds = params.redemptionMsgInstructions.map((msgInstructId) => ({ ...msgInstructId, status: 'REDEEMED' }));
    } else if (params.messageInstructionFlags) {
        messageInstructionIds = await obtainDefaultMessageInstructions(params.messageInstructionFlags);
    }
    
    const instructionToRds = {
        creatingUserId: params.creatingUserId,
        boostType,
        boostCategory,
        boostStartTime,
        boostEndTime,
        boostAmount: parseInt(boostAmountDetails[0], 10),
        boostUnit: boostAmountDetails[1],
        boostCurrency: boostAmountDetails[2],
        boostBudget,
        fromBonusPoolId: params.boostSource.bonusPoolId,
        fromFloatId: params.boostSource.floatId,
        forClientId: params.boostSource.clientId,
        statusConditions: params.statusConditions,
        boostAudience: params.boostAudience,
        boostAudienceSelection: params.boostAudienceSelection,
        messageInstructionIds,
        defaultStatus: params.initialStatus || 'CREATED'
    };

    if (boostType === 'REFERRAL') {
        instructionToRds.flags = [ 'REDEEM_ALL_AT_ONCE' ]
    }

    if (boostType === 'GAME') {
        instructionToRds.messageInstructionIds = {};
    }

    // logger('Sending to persistence: ', instructionToRds);
    const persistedBoost = await persistence.insertBoost(instructionToRds);
    logger('Result of RDS call: ', persistedBoost);

    if (Array.isArray(params.messagesToCreate) && params.messagesToCreate.length > 0) {
        const boostParams = {
            boostId: persistedBoost.boostId,
            creatingUserId: instructionToRds.creatingUserId, 
            audienceType: params.boostAudience, 
            boostEndTime
        };

        const messagePayloads = params.messagesToCreate.map((msg) =>  createMsgInstructionFromDefinition(msg, boostParams, params.gameParams));
        logger('Assembled message payloads: ', messagePayloads);

        const messageInvocations = messagePayloads.map((payload) => assembleMsgLamdbaInvocation(payload));
        logger(`About to fire off ${messageInvocations.length} invocations ...`);
        
        // todo : handle errors
        const messageInstructionResults = await Promise.all(messageInvocations);
        logger('Result of message instruct invocation: ', messageInstructionResults);
                
        const updatedBoost = await persistence.setBoostMessages(persistedBoost.boostId, messageInstructionResults, true);
        logger('And result of update: ', updatedBoost);
        persistedBoost.messageInstructions = messageInstructionResults;
    };

    return persistedBoost;

};

// Wrapper method for API gateway, handling authorization via the header, extracting body, etc. 
module.exports.createBoostWrapper = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);

        // logger('Boost create event: ', event);
        if (!userDetails || !util.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return { statusCode: status('Forbidden') };
        }

        const params = extractEventBody(event);
        params.creatingUserId = userDetails.systemWideUserId;

        const isOrdinaryUser = userDetails.userRole === 'ORDINARY_USER';
        if (isOrdinaryUser && ALLOWABLE_ORDINARY_USER.indexOf(params.boostTypeCategory) === -1) {
            return { statusCode: status('Forbidden'), body: 'Ordinary users cannot create boosts' };
        }

        const resultOfCall = await exports.createBoost(params);
        return util.wrapHttpResponse(resultOfCall);    
    } catch (err) {
        return handleError(err);
    }
};
