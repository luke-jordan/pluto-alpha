'use strict';

const logger = require('debug')('jupiter:message:picker');
const config = require('config');
const moment = require('moment');

const util = require('util');
const publisher = require('publish-common');

const persistence = require('./persistence/rds.msgpicker');
const dynamo = require('dynamo-common');
const userProfileTable = config.get('tables.dynamoProfileTable');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const paramRegex = /#{(?<paramName>[^}]*)}/g;

const STANDARD_PARAMS = [
    'user_first_name',
    'user_full_name',
    'current_balance',
    'opened_date',
    'total_interest'
];

const UNIT_DIVISORS = {
    'HUNDREDTH_CENT': 100 * 100,
    'WHOLE_CENT': 100,
    'WHOLE_CURRENCY': 1 
};

const PROFILE_COLS = ['system_wide_user_id', 'personal_name', 'family_name', 'creation_time_epoch_millis', 'default_currency'];

const getSubParamOrDefault = (paramSplit, defaultValue) => (paramSplit.length > 1 ? paramSplit[1] : defaultValue);

const formatAmountResult = (amountResult) => {
    logger('Formatting amount result: ', amountResult);
    const wholeCurrencyAmount = amountResult.amount / UNIT_DIVISORS[amountResult.unit];

    // JS's i18n for emerging market currencies is lousy, and gives back the 3 digit code instead of symbol, so have to hack for those
    // implement for those countries where client opcos have launched
    if (amountResult.currency === 'ZAR') {
        const emFormat = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
        return `R${emFormat.format(wholeCurrencyAmount)}`;
    }

    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: amountResult.currency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    });
    
    return numberFormat.format(wholeCurrencyAmount);
};

const fetchUserName = async (systemWideUserId, userProfile, firstNameOnly = true) => {
    let profileToUse = {};
    if (userProfile.systemWideUserId === systemWideUserId) {
        profileToUse = userProfile;
    } else {
        profileToUse = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId }, ['personal_name', 'family_name']);
    }
    return firstNameOnly ? profileToUse.personalName : `${profileToUse.personalName} ${profileToUse.familyName}`;
};

const fetchAccountOpenDates = (userProfile, dateFormat) => {
    const openMoment = moment(userProfile.creationTimeEpochMillis);
    return openMoment.format(dateFormat);
};

const fetchAccountInterest = async (systemWideUserId, currency, sinceTimeMillis) => {
    const operation = `interest::WHOLE_CENT::${currency}::${sinceTimeMillis}`;
    const amountResult = await persistence.getUserAccountFigure({ systemWideUserId, operation });
    logger('Retrieved from persistence: ', amountResult);
    return formatAmountResult(amountResult);
};

const fetchCurrentBalance = async (systemWideUserId, currency) => {
    const amountResult = await persistence.getUserAccountFigure({
        systemWideUserId, operation: `balance::WHOLE_CENT::${currency}`
    });
    logger('For balance, from persistence: ', amountResult);
    return formatAmountResult(amountResult);
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

const retrieveParamValue = async (param, destinationUserId, userProfile) => {
    const paramSplit = param.split('::');
    const paramName = paramSplit[0];
    logger('Params split: ', paramSplit, ' and dominant: ', paramName, ' for user ID: ', destinationUserId);
    if (STANDARD_PARAMS.indexOf(paramName) < 0) {
        return paramName; // redundant and unreachable but useful for robustness
    } else if (paramName === 'user_first_name') {
        const userId = getSubParamOrDefault(paramSplit, destinationUserId);
        return fetchUserName(userId, userProfile, true);
    } else if (paramName === 'user_full_name') {
        const userId = getSubParamOrDefault(paramSplit, destinationUserId, userProfile);
        logger('Fetching username with ID: ', userId);
        return fetchUserName(userId, userProfile, false);
    } else if (paramName === 'opened_date') {
        const specifiedDateFormat = getSubParamOrDefault(paramSplit, config.get('picker.defaults.dateFormat'));
        return fetchAccountOpenDates(userProfile, specifiedDateFormat);
    } else if (paramName === 'total_interest') {
        const sinceMillis = getSubParamOrDefault(paramSplit, 0); // i.e., beginning of time
        return fetchAccountInterest(destinationUserId, userProfile.defaultCurrency, sinceMillis);
    } else if (paramName === 'current_balance') {
        const defaultCurrency = getSubParamOrDefault(paramSplit, userProfile.defaultCurrency);
        logger('Have currency: ', defaultCurrency);
        return fetchCurrentBalance(destinationUserId, defaultCurrency, userProfile);
    }
};

const fillInTemplate = async (template, destinationUserId) => {
    const paramsToFillIn = extractParamsFromTemplate(template);
    if (!Array.isArray(paramsToFillIn) || paramsToFillIn.length === 0) {
        logger('Message template has no parameters, return it as is');
        return template;
    }

    const replacedString = template.replace(paramRegex, '%s');
    logger('String template looks like: ', replacedString);
    
    logger('Fetching user profile for ID: ', destinationUserId);
    const userProfile = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId: destinationUserId }, PROFILE_COLS);
    logger('Obtained user profile: ', userProfile);
    const paramValues = await Promise.all(paramsToFillIn.map((param) => retrieveParamValue(param, destinationUserId, userProfile)));
    logger('Obtained values: ', paramValues);
    const completedTemplate = util.format(replacedString, ...paramValues);
    logger('Here it is: ', completedTemplate);
    return completedTemplate;
};

/**
 * This function assembles user messages into a persistable object. It accepts a messageDetails object as its only argument.
 * @param {Object} messageDetails An object containing the message details. This object contains the following properties:
 * @property {String} messageId The message's id.
 * @property {String} messageTitle The message's title.
 * @property {Number} messagePriority The message's priority (ranging from 0 to 10, with 0 being the lowest and q0 being the highest priority)
 * @property {Object} display An object conataining additional icons to display within the message, e.g. { type: 'MODAL', iconType: 'SMILEY_FACE' }
 * @property {String} creationTime The message's creation time.
 * @property {Boolean} hasFollowingMessage a boolean value indicating whether the current message other message following it.
 * @property {Boolean} followsPriorMessage A boolean value indicating whether the current message follows other messages.
 * @property {Object} actionContext An object containing optional actions to be run during message assembly. For example { triggerBalanceFetch: true, boostId: '61af5b66-ad7a...' }
 * @property {Object} messageSequence An object containing details such as messages to display on the success of the current message. An example object: { msgOnSuccess: '61af5b66-ad7a...' }
 */
module.exports.assembleMessage = async (msgDetails) => {
    const completedMessageBody = await fillInTemplate(msgDetails.messageBody, msgDetails.destinationUserId);
    const messageBase = {
        messageId: msgDetails.messageId,
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
module.exports.fetchAndFillInNextMessage = async (destinationUserId, withinFlowFromMsgId = null) => {
    logger('Initiating message retrieval, excluding push notifications');
    const retrievedMessages = await persistence.getNextMessage(destinationUserId, true);
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
    return assembledMessages;
};

// And last, we update. todo : update all of them?
const fireOffMsgStatusUpdate = async (userMessages, requestContext, destinationUserId) => {
    const updateMsgPayload = {
        requestContext,
        body: JSON.stringify({ messageId: userMessages[0].messageId, userAction: 'FETCHED' })
    };

    const updateMsgLambdaParams = {
        FunctionName: config.get('lambdas.updateMessageStatus'),
        InvocationType: 'Event',
        Payload: JSON.stringify(updateMsgPayload) 
    };

    const logContext = {
        requestContext,
        messages: userMessages
    };

    logger('Invoking Lambda to update message status, and publishing user log');
    const invocationPromise = lambda.invoke(updateMsgLambdaParams).promise();
    const publishPromise = publisher.publishUserEvent(destinationUserId, 'MESSAGE_FETCHED', { context: logContext });
    const [invocationResult, publishResult] = await Promise.all([invocationPromise, publishPromise]);
    logger('Completed invocation: ', invocationResult);
    logger('And log publish result: ', publishResult);
};

// For now, for mobile test
const dryRunGameResponseOpening = require('./dry-run-messages');
const dryRunGameChaseArrows = require('./dry-run-arrow');

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

        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const queryParams = event.queryStringParameters;
        if (queryParams && queryParams.gameDryRun) {
            const relevantGame = queryParams.gameType || 'TAP_SCREEN';
            const messagesToReturn = relevantGame === 'CHASE_ARROW' ? dryRunGameChaseArrows : dryRunGameResponseOpening;
            return { statusCode: 200, body: JSON.stringify(messagesToReturn)};
        }

        const withinFlowFromMsgId = event.queryStringParameters ? event.queryStringParameters.anchorMessageId : null;
        const userMessages = await exports.fetchAndFillInNextMessage(userDetails.systemWideUserId, withinFlowFromMsgId);
        logger('Retrieved user messages: ', userMessages);
        const resultBody = {
            messagesToDisplay: userMessages
        };

        if (Array.isArray(userMessages) && userMessages.length > 0) {
            await fireOffMsgStatusUpdate(userMessages, event.requestContext);
        }

        logger(JSON.stringify(resultBody));
        return { statusCode: 200, body: JSON.stringify(resultBody) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};

/**
 * Simple (ish) method for updating a message once it has been delivered, etc.
 * @param {object} event An object containing the request context and request body. The body has message id and user action properties, detailed below.
 * @property {object} requestContext An object containing the callers system wide user id, role, and permissions. The event will not be processed without a valid request context. 
 * @property {string} body.messageId The messageId of the message to me updated.
 * @property {string} body.userAction The value to update the message option with. Valid values in this context are FETCHED and DISMISSED.
 */
module.exports.updateUserMessage = async (event) => {
    try {
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        if (!userDetails) {
            return { statusCode: 403 };
        }

        // todo : validate that the message corresponds to the user ID
        const { messageId, userAction } = JSON.parse(event.body);
        logger('Processing message ID update, based on user action: ', userAction);

        if (!messageId || messageId.length === 0) {
            return { statusCode: 400 };
        }

        let response = { };
        let updateResult = null;
        switch (userAction) {
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
            default:
                response = { statusCode: 400, body: 'UNKNOWN_ACTION' };
        }

        return response;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};
