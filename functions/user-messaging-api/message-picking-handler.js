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
}

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
}

const fetchUserName = async (systemWideUserId, firstNameOnly = true) => {
    const profileFetch = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId }, ['personal_name', 'family_name']);
    return firstNameOnly ? profileFetch.personalName : `${profileFetch.personalName} ${profileFetch.familyName}`;
};

const fetchAccountOpenDates = async (systemWideUserId, dateFormat) => {
    const profileFetch = await dynamo.fetchSingleRow(userProfileTable, { systemWideUserId }, ['creation_time_epoch_millis']);
    const openMoment = moment(profileFetch.creationTimeEpochMillis);
    return openMoment.format(dateFormat);
};

const fetchAccountInterest = async (systemWideUserId, sinceTimeMillis) => {
    const amountResult = await persistence.getUserAccountFigure({
        systemWideUserId, operation: `interest::sum::${sinceTimeMillis}`
    });
    logger('Retrieved from persistence: ', amountResult);
    return formatAmountResult(amountResult);
};

const fetchCurrentBalance = async (systemWideUserId, defaultCurrency = null) => {
    const amountResult = await persistence.getUserAccountFigure({
        systemWideUserId, operation: defaultCurrency ? 'balance::sum' : `balance::sum::${defaultCurrency}`
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

const retrieveParamValue = async (param, destinationUserId) => {
    const paramSplit = param.split('::');
    const paramName = paramSplit[0];
    logger('Params split: ', paramSplit, ' and dominant: ', paramName, ' for user ID: ', destinationUserId);
    if (STANDARD_PARAMS.indexOf(paramName) === -1) {
        return '';
    } else if (paramName === 'user_first_name') {
        const userId = getSubParamOrDefault(paramSplit, destinationUserId);
        return fetchUserName(userId, true);
    } else if (paramName === 'user_full_name') {
        const userId = getSubParamOrDefault(paramSplit, destinationUserId);
        logger('Fetching username with ID: ', userId);
        return fetchUserName(userId, false);
    } else if (paramName === 'opened_date') {
        const specifiedDateFormat = getSubParamOrDefault(paramSplit, config.get('picker.defaults.dateFormat'));
        return fetchAccountOpenDates(destinationUserId, specifiedDateFormat);  
    } else if (paramName === 'total_interest') {
        const sinceMillis = getSubParamOrDefault(paramSplit, 0); // i.e., beginning of time
        return fetchAccountInterest(destinationUserId, sinceMillis);
    } else if (paramName === 'current_balance') {
        const defaultCurrency = getSubParamOrDefault(paramSplit, null);
        return fetchCurrentBalance(destinationUserId, defaultCurrency);
    }
    return '';
}

const fillInTemplate = async (template, destinationUserId) => {
    logger('Filling in: ', template);
    const paramsToFillIn = extractParamsFromTemplate(template);
    const replacedString = template.replace(paramRegex, '%s');
    logger('Extracted params: ', paramsToFillIn);
    logger('Altered template: ', replacedString);
    const paramValues = await Promise.all(paramsToFillIn.map((param) => retrieveParamValue(param, destinationUserId)));
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
        flowMessage = openingMessages.find((msg) => msg.messageId = withinFlowFromMsgId);
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

/**
 * Wrapper for the above, based on token
 */
module.exports.getNextMessageForUser = async (event) => {
    try {
        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        if (!userDetails) {
            return { statusCode: 403 }
        };

        if (event.queryStringParameters && event.queryStringParameters.gameDryRun) {
            return { statusCode: 200, body: JSON.stringify(dryRunGameResponseOpening)}
        }

        const userMessages = await exports.fetchAndFillInNextMessage(userDetails.systemWideUserId);
        logger('Retrieved user messages: ', userMessages);
        const resultBody = {
            messagesToDisplay: userMessages
        };

        return { statusCode: 200, body: JSON.stringify(resultBody) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
}
