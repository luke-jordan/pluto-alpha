'use strict';

const logger = require('debug')('jupiter:message:picker');
const config = require('config');
const moment = require('moment');

const util = require('util');

const persistence = require('./persistence/rds.msgpicker');
const dynamo = require('dynamo-common');
const userProfileTable = config.get('tables.dynamoProfileTable');

const paramRegex = /#{([^}]*)}/g;
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

const getSubParamOrDefault = (paramSplit, defaultValue) => paramSplit.length > 1 ? paramSplit[1] : defaultValue;

const formatAmountResult = (amountResult) => {
    logger('Formatting amount result: ', amountResult);
    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: amountResult.currency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    });
    
    const wholeCurrencyAmount = amountResult.amount / UNIT_DIVISORS[amountResult.unit];
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
    logger('For balance, from persistence: ', fetchCurrentBalance);
    return formatAmountResult(amountResult);
};

const extractParamsFromTemplate = (template) => {
    const extractedParams = [];
    let match = paramRegex.exec(template);
    while (match !== null) {
        extractedParams.push(match[1]);
        match = paramRegex.exec(template);
    }
    return extractedParams;
};

const retrieveParamValue = async (param, destinationUserId, userProfile) => {
    const paramSplit = param.split('::');
    const paramName = paramSplit[0];
    logger('Params split: ', paramSplit, ' and dominant: ', paramName, ' for user ID: ', destinationUserId);
    if (STANDARD_PARAMS.indexOf(paramName) === -1) {
        return '';
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
    const userProfile = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId: destinationUserId }, PROFILE_COLS);
    logger('Obtained user profile: ', userProfile);
    const paramValues = await Promise.all(paramsToFillIn.map((param) => retrieveParamValue(param, destinationUserId, userProfile)));
    logger('Obtained values: ', paramValues);
    const completedTemplate = util.format(replacedString, ...paramValues);
    logger('Here it is: ', completedTemplate);
    return completedTemplate;
};

const assembleMessage = async (msgDetails) => {
    const completedMessageBody = await fillInTemplate(msgDetails.messageBody, msgDetails.destinationUserId);
    const displayDetails = { type: msgDetails.displayType, ...msgDetails.displayInstructions };
    const messageBase = {
        messageId: msgDetails.messageId,
        title: msgDetails.messageTitle,
        body: completedMessageBody,
        priority: msgDetails.messagePriority,
        display: displayDetails,
        hasFollowingMsg: msgDetails.hasFollowingMsg
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
    
    if (msgDetails.followingMessages) {
        actionContextForReturn = { ... actionContextForReturn, ...msgDetails.followingMessages };
    }

    if (!msgDetails.followsPriorMsg) {
        actionContextForReturn = { ...actionContextForReturn, sequenceExpiryTimeMillis: msgDetails.endTime.valueOf() };
    }

    messageBase.actionContext = actionContextForReturn;
    return messageBase;
};

const fetchMsgSequenceIds = (anchorMessage, retrievedMessages) => {
    // logger('Fetching sequence IDs from anchor: ', anchorMessage);
    if (!anchorMessage) {
        return [];
    }

    let thisAndFollowingIds = [anchorMessage.messageId];
    if (!anchorMessage.hasFollowingMsg || typeof anchorMessage.followingMessages !== 'object') {
        return thisAndFollowingIds;
    }

    Object.values(anchorMessage.followingMessages).forEach((msgId) => {
        const msgWithId = retrievedMessages.find((msg) => msg.messageId === msgId);
        thisAndFollowingIds = thisAndFollowingIds.concat(fetchMsgSequenceIds(msgWithId, retrievedMessages));
    });

    return thisAndFollowingIds;
};

const assembleSequence = async (anchorMessage, retrievedMessages) => {
    const sequenceIds = fetchMsgSequenceIds(anchorMessage, retrievedMessages);
    logger('Retrieved sequence IDs: ', sequenceIds);
    // this is a slightly inefficient double iteration, but it's in memory and the lists are going to be very small
    // in almost all cases, never more than a few messages (active/non-expired filter means only a handful at a time)
    // monitor and if that becomes untrue, then ajust, e.g., go to persistence or cache to extract IDs
    const sequenceMsgDetails = sequenceIds.map((msgId) => retrievedMessages.find((msg) => msg.messageId === msgId));
    return await Promise.all(sequenceMsgDetails.map((messageDetails) => assembleMessage(messageDetails)));
};

const determineAnchorMsg = (openingMessages) => {
    // if there is only one, then it is trivial
    if (openingMessages.length === 1) {
        return openingMessages[0];
    }

    // then, find the highest priority, using neat trick: https://stackoverflow.com/questions/4020796/finding-the-max-value-of-an-attribute-in-an-array-of-objects
    const highestPriorityAmongOpening = Math.max.apply(Math, openingMessages.map((msg) => msg.messagePriority));
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

module.exports.fetchAndFillInNextMessage = async (destinationUserId, withinFlowFromMsgId = null) => {
    logger('Initiating message retrieval');
    const retrievedMessages = await persistence.getNextMessage(destinationUserId);
    // first, check it's not empty. if so, return empty.
    if (!Array.isArray(retrievedMessages) || retrievedMessages.length === 0) {
        return [];
    }

    // second, select only the messages that do not depend on prior ones (i.e., that anchor chains)
    const openingMessages = retrievedMessages.filter((msg) => !msg.followsPriorMsg);

    // third, either just continue with the prior one, or find whatever should be the anchor
    let anchorMessage = null;
    if (withinFlowFromMsgId) {
        const flowMessage = openingMessages.find((msg) => msg.messageId = withinFlowFromMsgId);
        anchorMessage = typeof flowMessage === 'undefined' ? determineAnchorMsg(openingMessages) : flowMessage; 
    } else {
        anchorMessage = determineAnchorMsg(openingMessages);
    }

    const assembledMessages = await assembleSequence(anchorMessage, retrievedMessages);
    logger('Message retrieval complete');
    return assembledMessages;
};

// For now, for mobile test
const dryRunGameResponseOpening = require('./dry-run-messages');
const dryRunGameChaseArrows = require('./dry-run-arrow');

/**
 * Wrapper for the above, based on token
 */
module.exports.getNextMessageForUser = async (event) => {
    try {
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const queryParams = event.queryStringParameters;
        if (queryParams && queryParams.gameDryRun) {
            const relevantGame = queryParams.gameType || 'TAP_SCREEN';
            const messagesToReturn = relevantGame === 'CHASE_ARROW' ? dryRunGameChaseArrows : dryRunGameResponseOpening;
            return { statusCode: 200, body: JSON.stringify(messagesToReturn)}
        }

        const withinFlowFromMsgId = event.queryStringParameters ? event.queryStringParameters.anchorMessageId : undefined;
        const userMessages = await exports.fetchAndFillInNextMessage(userDetails.systemWideUserId, withinFlowFromMsgId);
        logger('Retrieved user messages: ', userMessages);
        const resultBody = {
            messagesToDisplay: userMessages
        };

        return { statusCode: 200, body: JSON.stringify(resultBody) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};

/**
 * Simple (ish) method for updating a message once it has been delivered, etc.
 */
module.exports.updateUserMessage = async (event) => {
    try {
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        if (!userDetails) {
            return { statusCode: 403 };
        }

        // todo : validate that the message corresponds to the user ID
        const { messageId, userAction }= JSON.parse(event.body);
        logger('Processing message ID update, based on user action: ', userAction);

        let response = { };
        switch (userAction) {
            case 'DISMISSED':
                const updateResult = await persistence.updateUserMessage(messageId, { processedStatus: 'DISMISSED' });
                const bodyOfResponse = { result: 'SUCCESS', processedTimeMillis: updateResult.updatedTime.valueOf() };
                response = { statusCode: 200, body: JSON.stringify(bodyOfResponse) };
                break;
            default:
                response = { statusCode: 400, body: 'UNKNOWN_ACTION' }
        };

        return response;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
}