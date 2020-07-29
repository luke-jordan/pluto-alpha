'use strict';

const logger = require('debug')('jupiter:boosts:create-core');
const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const publisher = require('publish-common');

const boostUtil = require('./boost.util');
const persistence = require('./persistence/rds.boost');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

// const ALLOWABLE_ORDINARY_USER = ['REFERRAL::USER_CODE_USED'];
const STANDARD_GAME_ACTIONS = {
    'OFFERED': { action: 'ADD_CASH' },
    'UNLOCKED': { action: 'PLAY_GAME' },
    'INSTRUCTION': { action: 'PLAY_GAME' },
    'REDEEMED': { action: 'DONE' },
    'FAILURE': { action: 'DONE' }
};

const STANDARD_BOOST_TYPES = {
    'GAME': ['CHASE_ARROW', 'TAP_SCREEN', 'DESTROY_IMAGE'],
    'SIMPLE': ['SIMPLE_SAVE', 'ROUND_UP', 'TARGET_BALANCE'],
    'REFERRAL': ['USER_CODE_USED'],
    'SOCIAL': ['FRIENDS_ADDED', 'NUMBER_FRIENDS'],
    'WITHDRAWAL': ['ABORT_WITHDRAWAL', 'CANCEL_WITHDRAWAL']
};

const DEFAULT_BOOST_PRIORITY = 100;

const obtainStdAction = (msgKey) => (Reflect.has(STANDARD_GAME_ACTIONS, msgKey) ? STANDARD_GAME_ACTIONS[msgKey].action : 'ADD_CASH'); 

const convertParamsToRedemptionCondition = (gameParams) => {
    const conditions = [];
    const timeLimitMillis = gameParams.timeLimitSeconds * 1000;
    switch (gameParams.gameType) {
        case 'CHASE_ARROW':
        case 'TAP_SCREEN': {
            if (gameParams.winningThreshold) {
                conditions.push(`number_taps_greater_than #{${gameParams.winningThreshold}::${timeLimitMillis}}`);
            }
            if (gameParams.numberWinners) {
                conditions.push(`number_taps_in_first_N #{${gameParams.numberWinners}::${timeLimitMillis}}`);
            }
            break;
        }
        case 'DESTROY_IMAGE': {
            if (gameParams.winningThreshold) {
                conditions.push(`percent_destroyed_above #{${gameParams.winningThreshold}::${timeLimitMillis}}`);
            }
            if (gameParams.numberWinners) {
                conditions.push(`percent_destroyed_in_first_N #{${gameParams.numberWinners}::${timeLimitMillis}}`);
            }
            break;
        }
        default:
            logger('ERROR! Unimplemented game');
            break;
    }
    return conditions;
};

const isInitialStatusBefore = (initialStatus, comparisonStatus) => {
    if (!initialStatus) {
        return true;
    }

    const statusOrder = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING', 'REDEEMED'];
    return statusOrder.indexOf(initialStatus) < statusOrder.indexOf(comparisonStatus);
};

const extractStatusConditions = (gameParams, initialStatus) => {
    // all games start with this
    const statusConditions = {};
    if (isInitialStatusBefore(initialStatus, 'OFFERED')) {
        statusConditions['OFFERED'] = ['message_instruction_created'];
    }
    if (isInitialStatusBefore(initialStatus, 'UNLOCKED')) {
        statusConditions['UNLOCKED'] = [gameParams.entryCondition];
    }
    if (isInitialStatusBefore(initialStatus, 'PENDING') && gameParams.numberWinners) {
        // this is a tournament, so add a pending condition, which is taps or percent above 0
        const relevantParam = gameParams.gameType === 'DESTROY_IMAGE' ? 'percent_destroyed_above' : 'number_taps_greater_than';
        statusConditions['PENDING'] = [`${relevantParam} #{0::${gameParams.timeLimitSeconds * 1000}}`];
    }
    if (isInitialStatusBefore(initialStatus, 'REDEEMED')) {
        statusConditions['REDEEMED'] = convertParamsToRedemptionCondition(gameParams);
    }
    return statusConditions;
};

// some processing help in here, to make sure we don't overwrite conditions already passed to us,
// but also that all conditions required for game params (= ground truth) to operate properly
const safeList = (conditionList) => (Array.isArray(conditionList) ? conditionList : []);

const checkConditionNotInList = (condition, comparisonList) => {
    const conditionType = condition.substring(0, condition.indexOf(' ')); // we could require strict match, but for now avoiding confusion
    const existsInList = comparisonList.some((otherCondition) => otherCondition.includes(conditionType));
    return !existsInList;
};

const safeMerge = (gameConditions, passedConditions, status) => {
    const gameConditionsNotInPassed = safeList(gameConditions[status]).filter((condition) => typeof condition === 'string').
        filter((condition) => checkConditionNotInList(condition, safeList(passedConditions[status])));
    return [...safeList(passedConditions[status]), ...gameConditionsNotInPassed];
};

const mergeStatusConditions = (gameParams, passedConditions, initialStatus) => {
    if (!passedConditions || Object.keys(passedConditions).length === 0) {
        return extractStatusConditions(gameParams, initialStatus);
    }

    let gameInitialStatus = initialStatus;
    if (initialStatus === 'UNCREATED') {
        const triggeredStatus = Object.keys(passedConditions).
            filter((boostStatus) => boostUtil.hasConditionType(passedConditions, boostStatus, 'event_occurs')).sort(boostUtil.statusSorter);
        gameInitialStatus = triggeredStatus.length > 0 ? triggeredStatus[0] : initialStatus;
    }
    
    logger('Game initial status: ', gameInitialStatus);
    const gameConditions = extractStatusConditions(gameParams, gameInitialStatus);
    
    logger('Merging game conditions: ', gameConditions, 'and passed conditions: ', passedConditions);
    const mergedConditions = boostUtil.ALL_BOOST_STATUS_SORTED.
        filter((boostStatus) => gameConditions[boostStatus] || passedConditions[boostStatus]).
        reduce((obj, boostStatus) => ({ ...obj, [boostStatus]: safeMerge(gameConditions, passedConditions, boostStatus)}), {});

    logger('Merged status conditions: ', mergedConditions);
    return mergedConditions;
};

// finds and uses existing message templates based on provided flags, in escalating series, given need to parallel process
// todo :: there will be a bunch of unnecessary queries in here, so particularly zip up the findMsgInstructionByFlag to take multiple flags
// and hence consolidate into a single operation / query, but can do later
const obtainMsgIdMatchedToAccount = async (flagDefinition, boostStatus) => {
    const msgInstructionId = await persistence.findMsgInstructionByFlag(flagDefinition.msgInstructionFlag);
    logger('Result of flag hunt: ', msgInstructionId);
    if (typeof msgInstructionId === 'string') {
        logger('Found a flag, returning it');
        return ({ accountId: flagDefinition.accountId, status: boostStatus, msgInstructionId });
    }
    return null; 
};

const obtainMessagePromise = async (boostStatus, messageInstructionFlags) => {
    const flagsForThisStatus = messageInstructionFlags[boostStatus];
    logger('Message flags for this boost status: ', flagsForThisStatus);
    const retrievedMsgs = await Promise.all(flagsForThisStatus.map((flagDefinition) => obtainMsgIdMatchedToAccount(flagDefinition, boostStatus)));
    const foundMsgs = retrievedMsgs.filter((msg) => msg !== null);
    return foundMsgs;
};

const obtainDefaultMessageInstructions = async (messageInstructionFlags) => {
    logger('Alright, got some message flags, we can go find the instructions, from: ', messageInstructionFlags);
    
    // cycle through the keys, which will represent the boost statuses, and find a message for each
    const statuses = Object.keys(messageInstructionFlags);
    logger('Have statuses: ', statuses);
    
    const messageInstructionsRaw = await Promise.all(statuses.map((boostStatus) => obtainMessagePromise(boostStatus, messageInstructionFlags)));
    const messageInstructions = Reflect.apply([].concat, [], messageInstructionsRaw.filter((result) => result.length > 0));
    
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
    // logger('Assembling message instruction from: ', messageDefinition);

    const msgPayload = {
        creatingUserId: boostParams.creatingUserId,
        boostStatus: messageDefinition.boostStatus,
        presentationType: messageDefinition.presentationType,
        audienceType: boostParams.boostAudienceType,
        audienceId: boostParams.audienceId,
        endTime: boostParams.boostEndTime.format(),
        messagePriority: DEFAULT_BOOST_PRIORITY
    };

    if (messageDefinition.presentationType === 'EVENT_DRIVEN') {
        msgPayload.triggerParameters = messageDefinition.triggerParameters;
    }

    if (messageDefinition.presentationType === 'ML_DETERMINED') {
        msgPayload.holdFire = true; // i.e., do not send right now
    }
        
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
            return { 'DEFAULT': msgTemplate, identifier: boostStatus };
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
    // logger('Sending payload to messsage instruction create: ', msgPayload);
    const messageInstructInvocation = {
        FunctionName: config.get('lambdas.messageInstruct'),
        InvocationType: 'RequestResponse',
        Payload: stringify(msgPayload) 
    };

    const resultOfMsgCreation = await lambda.invoke(messageInstructInvocation).promise();
    logger('Result of message invocation: ', resultOfMsgCreation);

    const resultPayload = JSON.parse(resultOfMsgCreation['Payload']);
    const resultBody = JSON.parse(resultPayload.body);
    logger('Result body on invocation: ', resultBody);

    return { accountId: 'ALL', status: msgPayload.boostStatus, msgInstructionId: resultBody.message.instructionId };
};

const generateAudienceInline = async (boostParams, isDynamic = false) => {
    const audiencePayload = {
        operation: 'create',
        params: {
            creatingUserId: boostParams.creatingUserId,
            clientId: boostParams.boostSource.clientId,
            isDynamic,
            conditions: boostParams.boostAudienceSelection.conditions
        }
    };

    const audienceInvocation = {
        FunctionName: config.get('lambdas.audienceHandle'),
        InvocationType: 'RequestResponse',
        Payload: stringify(audiencePayload)
    };

    const resultOfAudienceCreation = await lambda.invoke(audienceInvocation).promise();
    logger('Raw result of audience creation: ', resultOfAudienceCreation);

    const resultPayload = JSON.parse(resultOfAudienceCreation['Payload']);
    const resultBody = JSON.parse(resultPayload.body);
    logger('Result body for audience creation: ', resultBody);
    return resultBody.audienceId;
};

const obtainAudienceDetails = async (params) => {
    // this is slightly redundant, but will probably be useful for storing in future
    let boostAudienceType = '';
    if (params.boostAudienceType) {
        boostAudienceType = params.boostAudienceType;
    } else {
        boostAudienceType = 'GENERAL';
    }

    let audienceId = '';
    if (typeof params.audienceId === 'string' && params.audienceId.trim().length > 0) {
        audienceId = params.audienceId;
    } else {
        audienceId = await generateAudienceInline(params);
        logger('Created audience: ', audienceId);
    }

    return { boostAudienceType, audienceId };
};

const splitBasicParams = (params) => ({
    label: params.label || params.boostTypeCategory,
    boostType: params.boostTypeCategory.split('::')[0],
    boostCategory: params.boostTypeCategory.split('::')[1]
});

const validateBoostParams = (boostType, boostCategory, boostBudget, params) => {
    if (!STANDARD_BOOST_TYPES[boostType].includes(boostCategory)) {
        throw new Error('The boost type is not compatible with the boost category');
    }

    if (boostType === 'GAME' && !Reflect.has(params, 'gameParams')) {
        throw new Error('Boost games require game parameters');
    }

    if (boostType === 'GAME' && boostCategory !== params.gameParams.gameType) {
        throw new Error('Boost category must match game type where boost type is GAME');
    }

    if (params.boostAmountOffered.split('::')[0] > boostBudget) {
        throw new Error('Boost reward cannot be greater than boost budget');
    }

    return true;
};

const retrieveBoostAmounts = (params) => {
    const boostAmountDetails = params.boostAmountOffered.split('::');
    logger('Boost amount details: ', boostAmountDetails);
    
    let boostBudget = 0;
    if (typeof params.boostBudget === 'number') {
        boostBudget = params.boostBudget;
    } else if (typeof params.boostBudget === 'string') {
        const boostBudgetParams = params.boostBudget.split('::');
        if (boostAmountDetails[1] !== boostBudgetParams[1] || boostAmountDetails[2] !== boostBudgetParams[2]) {
            return boostUtil.wrapHttpResponse('Error! Budget must be in same unit & currency as amount', 400);
        }
        boostBudget = parseInt(boostBudgetParams[0], 10);
    } else {
        throw new Error('Boost must have a budget');
    }

    return { boostAmountDetails, boostBudget };
};

const publishBoostUserLogs = async (initiator, accountIds, boostContext, defaultStatus = 'CREATED') => {
    const userIds = await persistence.findUserIdsForAccounts(accountIds);
    const options = { initiator, context: boostContext };
    
    const { ALL_BOOST_STATUS_SORTED: allStatus } = boostUtil;
    const statusToLog = allStatus.filter((status) => allStatus.indexOf(status) <= allStatus.indexOf(defaultStatus));

    const promisePublicationMap = statusToLog.map((status) => `BOOST_${status}_${boostContext.boostType}`).
        map((eventType) => publisher.publishMultiUserEvent(userIds, eventType, options));

    logger('Triggering user logs for boost ... : user Ids: ', JSON.stringify(userIds));
    const resultOfLogPublish = await Promise.all(promisePublicationMap);
    logger('Result of log publishing: ', resultOfLogPublish);
};

const storeMessageInstructions = async (eventParams, boostParams) => {
    const messagePayloads = eventParams.messagesToCreate.map((msg) => createMsgInstructionFromDefinition(msg, boostParams, eventParams.gameParams));
    logger('Assembled message payloads: ', messagePayloads);

    const messageInvocations = messagePayloads.map((payload) => assembleMsgLamdbaInvocation(payload));
    logger(`About to fire off ${messageInvocations.length} invocations ...`);
    
    // todo : handle errors
    const messageInstructionResults = await Promise.all(messageInvocations);
    logger('Result of message instruct invocation: ', messageInstructionResults);
    
    const shouldOfferBoost = !['EVENT_DRIVEN', 'ML_DETERMINED'].includes(boostParams.boostAudienceType);
    const boostHasAccounts = boostParams.accountIds.length > 0; 
    const updatedBoost = await persistence.setBoostMessages(boostParams.boostId, messageInstructionResults, shouldOfferBoost && boostHasAccounts);
    logger('And result of update: ', updatedBoost);

    return messageInstructionResults;
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
 * 
 * Note (3) on rewardParameters: where provided the following properties are expected:
 * rewardType, required. Valid values are 'SIMPLE', 'RANDOM', and 'POOLED'. If reward rewardType is 'SIMPLE' no other properties are required.
 * If the rewardType is 'RANDOM' the following properties may be provided: distribution (default is UNIFORM), targetMean (default is use boostAmount),
 * significantFigures (optional - rounding amount, if not specified, amounts will be rounded to whole numbers), and realizedRewardModuloZeroTarget (optional - when provided only
 * amounts that leave no remainder when divided by this number will be used as rewards).
 * If rewardType is 'POOLED' the following properties must be provided: poolContributionPerUser (a sub-dict, with amount, unit, currency).
 * percentPoolAsReward (specifies how much of the pool gets awarded as the reward amount), additionalBonusToPool (defines how much the overall Jupiter bonus pool will
 * contribute to the reward, also a sub-dict with usual amount-unit-etc format).
 * @param {object} event An event object containing the request context and request body.
 * @property {string} creatingUserId The system wide user id of the user who is creating the boost.
 * @property {string} boostTypeCategory A composite string containing the boost type and the boost category, seperated by '::'. For example, 'SIMPLE::TIME_LIMITED'.
 * @property {string/number} boostBudget This may either be a number or a composite key containing the amount, the unit, and the currency, seperated by '::', e.g '10000000::HUNDREDTH_CENT::USD'.
 * @property {string} startTimeMillis A moment formatted date string indicating when the boost should become active. Defaults to now if not passed in by caller.
 * @property {string} endTime A moment formatted date string indicating when the boost should be deactivated. Defaults to 50 from now (true at time of writing, configuration may change).
 * @property {object} boostSource An object containing the bonusPoolId, clientId, and floatId associated with the boost being created.
 * @property {object} statusConditions An object containing an string array of DSL instructions containing details like how the boost should be saved.
 * @property {string} boostAudienceType A string denoting the boost audience. Valid values include GENERAL and INDIVIDUAL.
 * @property {string} audienceId The ID of the audience that the boost will be offered to. If left out, must have boostAudienceSelection.
 * @property {object} boostAudienceSelection A selection instruction for the audience for the boost. Primarily for internal invocations.
 * @property {array}  redemptionMsgInstructions An optional array containing message instruction objects. Each instruction object typically contains the accountId and the msgInstructionId.
 * @property {object} rewardParameters An optional object with reward details. expected properties are rewardType (valid values: 'SIMPLE', 'RANDOM', 'POOLED'). See Note (3) above.
 * @property {object} messageInstructionFlags An optional object with details on how to extract default message instructions for the boost being created.
 * @property {object} mlParameters Parameters that goven how the ML system will be invoked (if/when it is used)
 */
module.exports.createBoost = async (event) => {
    if (!event || Object.keys(event).length === 0) {
        logger('Warmup run on lambda, exiting');
        return { statusCode: 400 };
    }

    const params = event;
    logger('Creating boost with parameters: ', JSON.stringify(params, null, 2));

    const { creatingUserId } = params;
    const { label, boostType, boostCategory } = splitBasicParams(params);
    const { boostBudget, boostAmountDetails } = retrieveBoostAmounts(params);

    const paramValidationResult = validateBoostParams(boostType, boostCategory, boostBudget, params);
    logger('Are parameters valid:', paramValidationResult);

    if (typeof creatingUserId !== 'string') {
        throw new Error('Boost requires creating user ID');
    }

    // start now if nothing provided
    const boostStartTime = params.startTimeMillis ? moment(params.startTimeMillis) : moment();
    const boostEndTime = params.endTimeMillis ? moment(params.endTimeMillis) : moment().add(config.get('time.defaultEnd.value'), config.get('time.defaultEnd.unit'));

    logger(`Boost start time: ${boostStartTime.format()} and end time: ${boostEndTime.format()}`);
    logger('Boost source: ', params.boostSource, 'and creating user: ', params.creatingUserId);

    let messageInstructionIds = [];
    // many boosts will just do it this way, or else will use the more complex one below
    if (params.redemptionMsgInstructions) {
        messageInstructionIds = params.redemptionMsgInstructions.map((msgInstructId) => ({ ...msgInstructId, status: 'REDEEMED' }));
    } else if (params.messageInstructionFlags) {
        messageInstructionIds = await obtainDefaultMessageInstructions(params.messageInstructionFlags);
    }

    const { audienceId, boostAudienceType } = await obtainAudienceDetails(params);
    logger('Boost audience type: ', boostAudienceType, ' and audience ID: ', audienceId);
    
    const defaultStatus = params.initialStatus || 'CREATED';

    const instructionToRds = {
        creatingUserId,
        label,
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
        defaultStatus,
        audienceId,
        boostAudienceType,
        messageInstructionIds
    };

    if (boostType === 'REFERRAL') {
        instructionToRds.flags = ['REDEEM_ALL_AT_ONCE'];
    }

    if (boostType === 'GAME') {
        instructionToRds.messageInstructionIds = {};
        instructionToRds.gameParams = params.gameParams;
    }

    logger('Game params: ', params.gameParams, ' and default status: ', params.initialStatus);
    if (params.gameParams) {
        instructionToRds.statusConditions = mergeStatusConditions(params.gameParams, params.statusConditions, params.initialStatus);
    } else {
        instructionToRds.statusConditions = params.statusConditions;
    }

    if (Array.isArray(params.flags) && params.flags.length > 0) {
        logger('This boost is flagged, with: ', params.flags);
        instructionToRds.flags = params.flags;
    }

    const optionalComplexKeys = ['rewardParameters', 'mlParameters', 'expiryParameters'];
    
    optionalComplexKeys.filter((key) => params[key]).forEach((key) => {
        logger('Boost has :', key);
        instructionToRds[key] = params[key];
    });

    // logger('Sending to persistence: ', instructionToRds);
    const persistedBoost = await persistence.insertBoost(instructionToRds);
    logger('Result of RDS call: ', persistedBoost);

    const { boostId, accountIds } = persistedBoost;

    if (Array.isArray(accountIds) && accountIds.length > 0) {
        const logParams = boostUtil.constructBoostContext({ boostId, ...instructionToRds });
        logger('Publishing user logs with params: ', logParams);
        await publishBoostUserLogs(creatingUserId, accountIds, logParams, defaultStatus);
    }

    // logger('Do we have messages ? :', params.messagesToCreate);
    if (Array.isArray(params.messagesToCreate) && params.messagesToCreate.length > 0) {
        const boostParams = {
            boostId,
            accountIds,
            creatingUserId: instructionToRds.creatingUserId, 
            boostAudienceType,
            audienceId: params.audienceId,
            boostEndTime
        };

        logger('Passing boost params to message create: ', boostParams);

        persistedBoost.messageInstructions = await storeMessageInstructions(params, boostParams);
    }

    return persistedBoost;

};
