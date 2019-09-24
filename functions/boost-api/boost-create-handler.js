'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const moment = require('moment');
const status = require('statuses');
const stringify = require('json-stable-stringify');

const persistence = require('./persistence/rds.boost');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region' )});

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;
const extractUserDetails = (event) => event.requestContext ? event.requestContext.authorizer : null;

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

// this creates an instruction that has these 
const constructMsgInstructionPayload = (messageDefinitions, boostParams, gameParams) => {
    const msgPayload = {};
    
    msgPayload.audienceType = boostParams.audienceType;
    msgPayload.presentationType = 'EVENT_DRIVEN'; // constant
    msgPayload.selectionInstruction = `match_other from #{entityType: 'boost', entityId: ${boostParams.boostId}}`;

    const actionContext = { 
        boostId: boostParams.boostId,
        sequenceExpiryTimeMillis: boostParams.boostEndTime.valueOf(),
        gameParams: gameParams
    };

    const messageTemplates = Object.keys(messageDefinitions).map((key) => {
        const msgTemplate = messageDefinitions[key];
        msgTemplate.actionToTake = msgTemplate.actionToTake || obtainStdAction(key);
        msgTemplate.actionContext = actionContext;
        return { 'DEFAULT': msgTemplate, identifier: key }
    });

    msgPayload.templates = { 
        sequence: messageTemplates 
    };

    return msgPayload;
};

// Wrapper method for API gateway, for later
module.exports.createBoostWrapper = async (event) => {
    try {
        const userDetails = extractUserDetails(event);
        logger('Event: ', event);
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: status('Forbidden') };
        }

        const params = extractEventBody(event);
        params.creatingUserId = userDetails.systemWideUserId;

        const isOrdinaryUser = userDetails.userRole === 'ORDINARY_USER';
        if (isOrdinaryUser && ALLOWABLE_ORDINARY_USER.indexOf(params.boostTypeCategory) === -1) {
            return { statusCode: status('Forbidden'), body: 'Ordinary users cannot create boosts' };
        }

        const resultOfCall = await exports.createBoost(params);
        return {
            statusCode: status('Ok'),
            body: JSON.stringify(resultOfCall)
        };    
    } catch (err) {
        return handleError(err);
    }
};

// const find default message instruction
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
 * The primary method here. Creates a boost and sets various other methods into action
 * Note, there are three ways boosts can have their messages assigned:
 * (1) Include an explicit set of redemption message instructions
 * (2) Include a set of message instruction flags (i.e., ways to find defaults), as a dict with top-level key being the status
 * (3) Include the message definitions in messages to create
 * 
 * Note that if multiple are passed, (3) will override the others (as it is called last)
 * Also note that if none are provided the boost will have no message and just hang in the ether
 */
module.exports.createBoost = async (event) => {
    if (!event) {
        logger('Test run on lambda, exiting');
        return { statusCode: 400 };
    }

    const params = event;
    logger('Received boost instruction event: ', params);

    // todo : extensive validation
    const boostType = params.boostTypeCategory.split('::')[0];
    const boostCategory = params.boostTypeCategory.split('::')[1];

    logger(`Boost type: ${boostType} and category: ${boostCategory}`);

    const boostAmountDetails = params.boostAmountOffered.split('::');
    logger('Boost amount details: ', boostAmountDetails);

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

    if (params.messagesToCreate) {
        const boostParams = { boostId: persistedBoost.boostId, audienceType: params.boostAudience, boostEndTime };
        const messagePayload = constructMsgInstructionPayload(params.messagesToCreate, boostParams, params.gameParams);
        const messageInstructInvocation = {
            FunctionName: config.get('lambdas.messageInstruct'),
            InvocationType: 'RequestResponse',
            Payload: stringify(messagePayload) 
        };
        if (!params.onlyRdsCalls) {
            const resultOfMsgCreation = await lambda.invoke(messageInstructInvocation).promise();
            logger('Result of message instruct invocation: ', resultOfMsgCreation);
            // todo : handle errors
            const resultPayload = JSON.parse(resultOfMsgCreation.Payload);
            const resultBody = JSON.parse(resultPayload.body);
            const messageInstructionIds = { instructions: [{ accountId: 'ALL', status: 'ALL', msgInstructionId: resultBody[0].instructionId }] };
            const updatedBoost = await persistence.alterBoost(persistedBoost.boostId, { messageInstructionIds });
            logger('And result of update: ', updatedBoost);
            persistedBoost.messageInstructions = messageInstructionIds.instructions;
        } else {
            logger('Would send to Lambda: ', JSON.stringify(messagePayload));
        }
    };

    return persistedBoost;

};

