'use strict';

const logger = require('debug')('jupiter:message:picker');
const config = require('config');
const moment = require('moment');

const util = require('util');
const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const persistence = require('./persistence/rds.usermessages');
const dynamo = require('dynamo-common');
const userProfileTable = config.get('tables.dynamoProfileTable');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const paramRegex = /#{(?<paramName>[^}]*)}/g;

const STANDARD_PARAMS = [
    'user_first_name',
    'user_full_name',
    'user_referral_code',
    'current_balance',
    'opened_date',
    'total_interest',
    'last_capitalization',
    'total_earnings',
    'last_saved_amount',
    'next_major_digit',
    'saving_heat_points',
    'saving_heat_level'
];

const UNIT_DIVISORS = {
    'HUNDREDTH_CENT': 100 * 100,
    'WHOLE_CENT': 100,
    'WHOLE_CURRENCY': 1 
};

const PROFILE_COLS = ['system_wide_user_id', 'personal_name', 'family_name', 'called_name', 'referral_code', 'creation_time_epoch_millis', 'default_currency'];

const getSubParamOrDefault = (paramSplit, defaultValue) => (paramSplit.length > 1 ? paramSplit[1] : defaultValue);

const formatAmountResult = (amountResult, desiredDigits = 0) => {
    // logger('Formatting amount result: ', amountResult);
    const wholeCurrencyAmount = amountResult.amount / UNIT_DIVISORS[amountResult.unit];

    // JS's i18n for emerging market currencies is lousy, and gives back the 3 digit code instead of symbol, so have to hack for those
    // implement for those countries where client opcos have launched
    if (amountResult.currency === 'ZAR') {
        const emFormat = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: desiredDigits, minimumFractionDigits: desiredDigits });
        return `R${emFormat.format(wholeCurrencyAmount)}`;
    }

    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: amountResult.currency,
        maximumFractionDigits: desiredDigits,
        minimumFractionDigits: desiredDigits
    });
    
    return numberFormat.format(wholeCurrencyAmount);
};

const fetchUserName = async (systemWideUserId, userProfile, firstNameOnly = true) => {
    let profileToUse = {};
    if (userProfile.systemWideUserId === systemWideUserId) {
        profileToUse = userProfile;
    } else {
        profileToUse = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId }, ['personal_name', 'family_name', 'called_name']);
    }
    const userCalledName = profileToUse.calledName || profileToUse.personalName;
    return firstNameOnly ? userCalledName : `${userCalledName} ${profileToUse.familyName}`;
};

const fetchAccountOpenDates = (userProfile, dateFormat) => {
    const openMoment = moment(userProfile.creationTimeEpochMillis);
    return openMoment.format(dateFormat);
};

const extractParamsFromTemplate = (template) => {
    const extractedParams = [];
    let match = paramRegex.exec(template);
    while (match !== null) {
        extractedParams.push(match.groups.paramName);
        match = paramRegex.exec(template);
    }
    // do not include any that are non-standard
    return extractedParams.filter((paramName) => STANDARD_PARAMS.indexOf(paramName) >= 0);
};

const fetchAccountFigureRaw = async (aggregateOperation, systemWideUserId) => {
    const invocation = {
        FunctionName: config.get('lambdas.fetchAccountAggregate'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ aggregates: [aggregateOperation], systemWideUserId })
    };
    logger('Aggregate invocation: ', JSON.stringify(invocation));
    const resultOfInvoke = await lambda.invoke(invocation).promise();
    logger('Aggregate response: ', resultOfInvoke);
    const resultBody = JSON.parse(resultOfInvoke['Payload']);
    return resultBody.results[0];
};

// todo : all at once if multiple params
const fetchAccountAggFigure = async (aggregateOperation, systemWideUserId, desiredDigits = 0) => {
    const amountDict = await fetchAccountFigureRaw(aggregateOperation, systemWideUserId);
    return formatAmountResult(amountDict, desiredDigits);
};

const calculateNextMilestoneDigit = async (userProfile) => {
    const { defaultCurrency: currency } = userProfile;
    const currentBalance = await fetchAccountFigureRaw(`balance::WHOLE_CURRENCY::${currency}`, userProfile.systemWideUserId);
    logger('Calculating next milestone digit for user with balance: ', currentBalance);

    const nextMilestoneAmount = opsUtil.findNearestMajorDigit(currentBalance, 'WHOLE_CURRENCY');
    logger('Calculed next amount: ', nextMilestoneAmount);

    return formatAmountResult({ amount: nextMilestoneAmount, unit: 'WHOLE_CURRENCY', currency }, 0);
};

const fetchHeatLevel = async (systemWideUserId) => {
    const accountFetchResult = await fetchAccountFigureRaw('saving_heat_level', systemWideUserId);
    return accountFetchResult.currentLevelName;
};

const fetchHeatPoints = async (systemWideUserId) => {
    const accountFetchResult = await fetchAccountFigureRaw('saving_heat_points', systemWideUserId);
    return accountFetchResult.currentPeriodPoints;
};

const retrieveParamValue = async (param, destinationUserId, userProfile) => {
    const paramSplit = param.split('::');
    const paramName = paramSplit[0];
    // logger('Params split: ', paramSplit, ' and dominant: ', paramName, ' for user ID: ', destinationUserId);
    if (STANDARD_PARAMS.indexOf(paramName) < 0) {
        return paramName; // redundant and unreachable but useful for robustness
    } else if (paramName === 'user_first_name') {
        const userId = getSubParamOrDefault(paramSplit, destinationUserId);
        return fetchUserName(userId, userProfile, true);
    } else if (paramName === 'user_full_name') {
        const userId = getSubParamOrDefault(paramSplit, destinationUserId, userProfile);
        logger('Fetching username with ID: ', userId);
        return fetchUserName(userId, userProfile, false);
    } else if (paramName === 'user_referral_code') {
        const { referralCode } = userProfile;
        return referralCode;
    } else if (paramName === 'opened_date') {
        const specifiedDateFormat = getSubParamOrDefault(paramSplit, config.get('picker.defaults.dateFormat'));
        return fetchAccountOpenDates(userProfile, specifiedDateFormat);
    } else if (paramName === 'total_interest') {
        const sinceMillis = getSubParamOrDefault(paramSplit, 0); // i.e., beginning of time
        const aggregateOperation = `interest::HUNDREDTH_CENT::${userProfile.defaultCurrency}::${sinceMillis}`;
        return fetchAccountAggFigure(aggregateOperation, destinationUserId);
    } else if (paramName === 'current_balance') {
        const aggregateOperation = `balance::HUNDREDTH_CENT::${userProfile.defaultCurrency}`;
        return fetchAccountAggFigure(aggregateOperation, destinationUserId);
    } else if (paramName === 'last_capitalization') {
        const aggregateOperation = `capitalization::${userProfile.defaultCurrency}`;
        return fetchAccountAggFigure(aggregateOperation, destinationUserId, 2);
    } else if (paramName === 'last_saved_amount') {
        const aggregateOperation = `last_saved_amount::${userProfile.defaultCurrency}`;
        return fetchAccountAggFigure(aggregateOperation, destinationUserId);
    } else if (paramName === 'total_earnings') {
        const thisMonthOnly = getSubParamOrDefault(paramSplit, false);
        const opSuffix = `HUNDREDTH_CENT::${userProfile.defaultCurrency}${thisMonthOnly ? moment().startOf('month').valueOf() : ''}`;
        const aggregateOperation = `total_earnings::${opSuffix}`;
        return fetchAccountAggFigure(aggregateOperation, destinationUserId);
    } else if (paramName === 'next_major_digit') {
        return calculateNextMilestoneDigit(userProfile);
    } else if (paramName === 'saving_heat_points') {
        return fetchHeatPoints(destinationUserId);
    } else if (paramName === 'saving_heat_level') {
        return fetchHeatLevel(destinationUserId);
    }
};

const fillInTemplate = async (template, destinationUserId) => {
    const paramsToFillIn = extractParamsFromTemplate(template);
    if (!Array.isArray(paramsToFillIn) || paramsToFillIn.length === 0) {
        logger('Message template has no parameters, return it as is');
        return template;
    }

    const replacedString = template.replace(paramRegex, '%s');
    // logger('String template looks like: ', replacedString);
    
    logger('Fetching user profile for ID: ', destinationUserId);
    const userProfile = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId: destinationUserId }, PROFILE_COLS);
    logger('Obtained user profile: ', userProfile);
    const paramValues = await Promise.all(paramsToFillIn.map((param) => retrieveParamValue(param, destinationUserId, userProfile)));
    logger('Obtained values: ', paramValues);
    const completedTemplate = util.format(replacedString, ...paramValues);
    logger('Here it is: ', completedTemplate);
    return completedTemplate;
};

const fireOffMsgStatusUpdate = async (userMessages, destinationUserId, eventContext) => {
    const { userAction, eventType } = eventContext;

    const updateInvocations = userMessages.map((message) => ({
        FunctionName: config.get('lambdas.updateMessageStatus'),
        InvocationType: 'Event',
        Payload: JSON.stringify({ messageId: message.messageId, userAction, lastDisplayedBody: message.body })
    }));

    const logContext = { messages: userMessages };

    logger('Invoking Lambda to update message status, and publishing user log');
    const invocationPromises = updateInvocations.map((invocation) => lambda.invoke(invocation).promise());
    const publishPromise = publisher.publishUserEvent(destinationUserId, eventType, { context: logContext });
    const [invocationResult, publishResult] = await Promise.all([...invocationPromises, publishPromise]);
    logger('Completed invocation: ', invocationResult);
    logger('And log publish result: ', publishResult);
};

/**
 * This function assembles user messages into a persistable object. It accepts a messageDetails object as its only argument.
 * @param {Object} messageDetails An object containing the message details. This object contains the following properties:
 * @property {String} messageId The message's id.
 * @property {String} messageTitle The message's title.
 * @property {Number} messagePriority The message's priority (ranging from 0 to 10, with 0 being the lowest and 10 being the highest priority)
 * @property {Object} display An object conataining additional icons to display within the message, e.g. { type: 'MODAL', iconType: 'SMILEY_FACE' }
 * @property {String} creationTime The message's creation time.
 * @property {Boolean} hasFollowingMessage a boolean value indicating whether the current message other message following it.
 * @property {Boolean} followsPriorMessage A boolean value indicating whether the current message follows other messages.
 * @property {Object} actionContext An object containing optional actions to be run during message assembly. For example { triggerBalanceFetch: true, boostId: '61af5b66-ad7a...' }
 * @property {Object} messageSequence An object containing details such as messages to display on the success of the current message. An example object: { msgOnSuccess: '61af5b66-ad7a...' }
 */
module.exports.assembleMessage = async (msgDetails) => {
    try {
        const completedMessageBody = await fillInTemplate(msgDetails.messageBody, msgDetails.destinationUserId);
        const messageBase = {
            messageId: msgDetails.messageId,
            instructionId: msgDetails.instructionId, // for logging & tracing
            title: msgDetails.messageTitle,
            body: completedMessageBody,
            priority: msgDetails.messagePriority,
            display: msgDetails.display,
            persistedTimeMillis: msgDetails.creationTime.valueOf(),
            hasFollowingMessage: msgDetails.hasFollowingMessage
        };
        
        let actionContextForReturn = { };
        if (msgDetails.actionContext) {
            messageBase.actionToTake = msgDetails.actionContext.actionToTake;
            messageBase.triggerBalanceFetch = msgDetails.actionContext.triggerBalanceFetch;
            const strippedContext = JSON.parse(JSON.stringify(msgDetails.actionContext));
            Reflect.deleteProperty(strippedContext, 'actionToTake');
            Reflect.deleteProperty(strippedContext, 'triggerBalanceFetch');
            actionContextForReturn = { ...actionContextForReturn, ...strippedContext };   
        }
        
        if (msgDetails.messageSequence) {
            const sequenceDict = msgDetails.messageSequence;
            messageBase.messageSequence = sequenceDict;
            const thisMessageIdentifier = Object.keys(sequenceDict).find((key) => sequenceDict[key] === msgDetails.messageId);
            messageBase.identifier = thisMessageIdentifier;
        }
    
        if (!msgDetails.followsPriorMessage) {
            actionContextForReturn = { ...actionContextForReturn, sequenceExpiryTimeMillis: msgDetails.endTime.valueOf() };
        }
    
        messageBase.actionContext = actionContextForReturn;
        return messageBase;
    } catch (err) {
        logger('FATAL_ERROR:', err);
        const eventContext = { userAction: 'EXPIRED', eventType: 'MESSAGE_FAILED' };
        await fireOffMsgStatusUpdate([msgDetails], msgDetails.destinationUserId, eventContext);
        return {};
    }
 
};

const fetchMsgSequenceIds = (anchorMessage) => {
    // logger('Fetching sequence IDs from anchor: ', anchorMessage);
    if (!anchorMessage) {
        return [];
    }

    const thisAndFollowingIds = [anchorMessage.messageId];
    
    if (!anchorMessage.hasFollowingMessage || typeof anchorMessage.messageSequence !== 'object') {
        return thisAndFollowingIds;
    }

    const otherMsgIds = Object.values(anchorMessage.messageSequence).filter((msgId) => msgId !== anchorMessage.messageId);

    return thisAndFollowingIds.concat(otherMsgIds);
};

const assembleSequence = async (anchorMessage, retrievedMessages) => {
    const sequenceIds = fetchMsgSequenceIds(anchorMessage, retrievedMessages);
    logger('Retrieved sequence IDs: ', sequenceIds);
    // this is a slightly inefficient double iteration, but it's in memory and the lists are going to be very small
    // in almost all cases, never more than a few messages (active/non-expired filter means only a handful at a time)
    // monitor and if that becomes untrue, then ajust, e.g., go to persistence or cache to extract IDs
    const sequenceMsgDetails = sequenceIds.map((msgId) => retrievedMessages.find((msg) => msg.messageId === msgId));
    return Promise.all(sequenceMsgDetails.map((messageDetails) => exports.assembleMessage(messageDetails)));
};

const determineAnchorMsg = (openingMessages) => {
    logger('Determining anchor message');
    // if there is only one, then it is trivial
    if (openingMessages.length === 1) {
        return openingMessages[0];
    }

    // then, find the highest priority, using neat trick: https://stackoverflow.com/questions/4020796/finding-the-max-value-of-an-attribute-in-an-array-of-objects
    const highestPriorityAmongOpening = Reflect.apply(Math.max, Math, openingMessages.map((msg) => msg.messagePriority));
    logger('Highest priority among current messages: ', highestPriorityAmongOpening);

    const messagesWithHighestPriority = openingMessages.filter((msg) => msg.messagePriority === highestPriorityAmongOpening);
    // again, if only one left, return it
    if (messagesWithHighestPriority.length === 1) {
        return messagesWithHighestPriority[0];
    }

    // otherwise, return the oldest one. note: any expired ones, or max read ones, are removed during RDS selection.
    // second note: adopting FIFO here because: (1) makes this deterministic on subsequent calls, (2) coin toss between principle of show
    // user the latest thing, and show user the oldest thing, which may have the earliest deadline. Could also use earliest deadline.
    // can adjust this in the future depending. Implemented by compare function: (a, b) => a - b puts a first if it is less than b.
    messagesWithHighestPriority.sort((msg1, msg2) => msg1.startTime.valueOf() - msg2.startTime.valueOf()); 

    return messagesWithHighestPriority[0];
};

/**
 * This function fetches and fills in the next message in a sequence of messages.
 * @param {string} destinationUserId The messages destination user id.
 * @param {string} withinFlowFromMsgId The messageId of the last message in the sequence to be processed prior to the current one.
 */
module.exports.fetchAndFillInNextMessage = async ({ destinationUserId, instructionId, withinFlowFromMsgId }) => {
    logger('Initiating message retrieval, of just card notifications, for user: ', destinationUserId);
    const retrievedMessages = await (instructionId 
        ? persistence.getInstructionMessage(destinationUserId, instructionId)
        : persistence.getNextMessage(destinationUserId, ['CARD']) 
    );
    logger('Retrieved from RDS: ', retrievedMessages);
    // first, check it's not empty. if so, return empty.
    if (!Array.isArray(retrievedMessages) || retrievedMessages.length === 0) {
        return [];
    }

    // second, select only the messages that do not depend on prior ones (i.e., that anchor chains)
    const openingMessages = retrievedMessages.filter((msg) => !msg.followsPriorMessage);
    logger('Possible opening messages: ', openingMessages);

    // third, either just continue with the prior one, or find whatever should be the anchor
    let anchorMessage = null;
    if (withinFlowFromMsgId) {
        const flowMessage = openingMessages.find((msg) => msg.messageId === withinFlowFromMsgId);
        anchorMessage = typeof flowMessage === 'undefined' ? determineAnchorMsg(openingMessages) : flowMessage;
    } else {
        anchorMessage = determineAnchorMsg(openingMessages);
    }

    const assembledMessages = await assembleSequence(anchorMessage, retrievedMessages);
    logger('Message retrieval complete');
    return assembledMessages.filter((message) => JSON.stringify(message) !== '{}');
};

/**
 * Wrapper for the above, based on token, i.e., direct fetch
 * @param {object} event An object containing the request context, with request body being passed as query string parameters.
 * @property {object} requestContext An object containing the callers id, roles, and permissions. The event will not be processed without a valid request context.
 * @property {object} queryStringParameters This functions accepts an lambda event passed via query string parameters. The queryStringParameters object may have the following properties:
 * @property {boolean} queryStringParameters.gameDryRun Set to true to run a dry run operation, else omit or set to false to run full function operations.
 * @property {string} queryStringParameters.anchorMessageId If message is part of a sequence, this property contains the messageId of the last processed message in the sequence before the current one.
 */
module.exports.getNextMessageForUser = async (event) => {
    try {
        if (!event || typeof event !== 'object' || Object.keys(event).length === 0) {
            logger('Warmup trigger, just keep live and exit');
        }

        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        const destinationUserId = userDetails.systemWideUserId;
        
        // here we have multiple flow options: either we have an 'anchor message' that starts the sequence, or we have
        // a message instruction ID, which then produces all the messages for the user that follow that message, or
        // we have an instruction ID, in which case we pull the messages for that instruction
        const queryParams = event.queryStringParameters || {};
        const { withinFlowFromMsgId, instructionId } = queryParams;

        const userMessages = await exports.fetchAndFillInNextMessage({ destinationUserId, withinFlowFromMsgId, instructionId });
        logger('Retrieved user messages: ', userMessages);
        const resultBody = { messagesToDisplay: userMessages };

        if (Array.isArray(userMessages) && userMessages.length > 0) {
            const eventContext = { userAction: 'FETCHED', eventType: 'MESSAGE_FETCHED' };
            await fireOffMsgStatusUpdate(userMessages, destinationUserId, eventContext);
        }

        logger(JSON.stringify(resultBody));
        return { statusCode: 200, body: JSON.stringify(resultBody) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};

module.exports.getUserHistoricalMessages = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { displayTypes } = opsUtil.extractQueryParams(event);

        const messageTypes = displayTypes ? displayTypes : ['CARD'];
        const destinationUserId = userDetails.systemWideUserId;

        const userMessages = await persistence.fetchUserHistoricalMessages(destinationUserId, messageTypes, true);
        const lastDisplayedBody = userMessages.map((message) => ({ ...message, displayedBody: message.lastDisplayedBody || message.messageBody }));
        logger('Got user messages:', lastDisplayedBody);

        return { statusCode: 200, body: JSON.stringify(lastDisplayedBody) };

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};

/**
 * Simple (ish) method for updating a message once it has been delivered, etc.
 * @param {object} event An object containing the request context and request body. The body has message id and user action properties, detailed below.
 * @property {object} requestContext An object containing the callers system wide user id, role, and permissions. The event will not be processed without a valid request context. 
 * @property {parameter} messageId The messageId of the message to me updated.
 * @property {parameter} userAction The value to update the message with. Valid values in this context are FETCHED and DISMISSED.
 * @property {parameter} newStatus The value to set the message status.
 */
module.exports.updateUserMessage = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        // todo : validate that the message corresponds to the user ID
        const { messageId, userAction, newStatus, lastDisplayedBody } = opsUtil.extractParamsFromEvent(event);
        logger('Processing message ID update, based on user action: ', userAction);

        if (lastDisplayedBody) {
            const resultOfUpdate = await persistence.updateUserMessage(messageId, { lastDisplayedBody });
            logger('Result of message update:', resultOfUpdate);
        }

        if (!messageId || messageId.length === 0) {
            return { statusCode: 400 };
        }

        let response = { };
        let updateResult = null;

        const updateType = userAction || newStatus;
        switch (updateType) {
            case 'FETCHED': {
                updateResult = await persistence.updateUserMessage(messageId, { processedStatus: 'FETCHED' });
                logger('Result of updating message: ', updateResult);
                return { statusCode: 200 };
            }
            case 'DISMISSED': {
                updateResult = await persistence.updateUserMessage(messageId, { processedStatus: 'DISMISSED' });
                const bodyOfResponse = { result: 'SUCCESS', processedTimeMillis: updateResult.updatedTime.valueOf() };
                response = { statusCode: 200, body: JSON.stringify(bodyOfResponse) };
                break;
            }
            case 'ACTED': {
                updateResult = await persistence.updateUserMessage(messageId, { processedStatus: 'ACTED' });
                response = { statusCode: 200 };
                break;
            }
            case 'SUPERCEDED': {
                // todo : possibly also change the end time
                updateResult = await persistence.updateUserMessage(messageId, { processedStatus: 'SUPERCEDED' });
                response = { statusCode: 200 };
                break;
            }
            case 'EXPIRED': {
                updateResult = await persistence.updateUserMessage(messageId, { processedStatus: 'EXPIRED' });
                response = { statusCode: 200 };
                break;
            }
            default:
                response = { statusCode: 400, body: 'UNKNOWN_ACTION' };
        }

        return response;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};
