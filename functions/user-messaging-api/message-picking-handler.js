'use strict';

const logger = require('debug')('jupiter:message:picker');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid');

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

module.exports.fetchAndFillInNextMessage = async (destinationUserId) => {
    const retrievedMessage = await persistence.getNextMessage({ destinationUserId });
    logger('Retrieved message from persistence: ', retrievedMessage);
    const completedMessage = await fillInTemplate(retrievedMessage.template, retrievedMessage.destinationUserId);
    logger('Completed message construction: ', completedMessage);
    return { messageBody: completedMessage, messageDetails: retrievedMessage };
};

// For now, for mobile test
const dryRunGameResponseOpening = () => {
    const boostId = uuid();
    const msgIds = [uuid(), uuid(), uuid(), uuid()];

    return {
        messagesToDisplay: [{
            msgId: msgIds[0],
            title: 'Win big with the next boost challenge',
            body: 'Top-up with R20.00 to unlock this boost challenge. Once unlocked, you will stand a chance to win R20.00 after completing a fun challenge!',
            priority: 100,
            type: 'CARD',
            triggerBalanceFetch: false,
            actionToTake: 'ADD_CASH',
            actionContext: {
                boostId,
                msgOnSuccess: msgIds[1],
                sequenceExpiryTimeMillis: moment().add(10, 'minutes').valueOf()
            }
        }, {
            msgId: msgIds[1],
            title: 'Boost Challenge Unlocked!',
            body: 'Your top up was successful and you now stand a chance to win R20.00. Follow the instructions below to play the game:',
            priority: 100,
            type: 'MODAL',
            triggerBalanceFetch: false,
            actionToTake: 'PLAY_GAME',
            actionContext: {
                boostId,
                gameType: 'TAP_SCREEN',
                gameParams: {
                    timeLimitSeconds: '20',
                    instructionBand: 'Tap the screen as many times as you can in 20 seconds',
                    waitMessage: msgIds[2],
                    finishedMessage: msgIds[3]
                }
            }
        }, {
            msgId: msgIds[2],
            title: 'Boost challenge unlocked!',
            body: 'You’ve unlocked this challenge and stand a chance of winning R20.00, which will be added to your savings. Challenge will remain open until the end of the day.',
            priority: 100,
            type: 'CARD',
            actionToTake: 'PLAY_GAME',
            actionContext: {
                boostId,
                gameType: 'TAP_SCREEN',
                gameParams: {
                    openingMsg: msgIds[1]
                }
            },
        }, {
            msgId: msgIds[3],
            title: 'Nice Work!',
            body: 'You tapped #{numberUserTaps} in 20 seconds! Winners of the challenge will be notified later today. Good luck!',
            priority: 100,
            type: 'MODAL',
            actionToTake: 'DONE',
            actionContext: {
                boostId,
                checkOnDismissal: true
            }
        }]
    };
}

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
            return { statusCode: 200, body: JSON.stringify(dryRunGameResponseOpening())}
        }

        const userMessage = await exports.fetchAndFillInNextMessage(userDetails.systemWideUserId);
        logger('Retrieved user message: ', userMessage);

        return { statusCode: 200, body: JSON.stringify(userMessage) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
}
