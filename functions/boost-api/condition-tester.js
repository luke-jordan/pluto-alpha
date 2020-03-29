'use strict';

const logger = require('debug')('jupiter:boost:condition-tester');
const moment = require('moment');

const util = require('./boost.util');

// expects in form AMOUNT::UNIT::CURRENCY
const equalizeAmounts = (amountString) => {
    const amountArray = amountString.split('::');
    const unitMultipliers = {
        'HUNDREDTH_CENT': 1,
        'WHOLE_CENT': 100,
        'WHOLE_CURRENCY': 100 * 100
    };
    return parseInt(amountArray[0], 10) * unitMultipliers[amountArray[1]];
};

const currency = (amountString) => amountString.split('::')[2];

const safeEvaluateAbove = (eventContext, amountKey, thresholdAmount) => {
    if (typeof eventContext[amountKey] !== 'string') {
        return false;
    }

    return equalizeAmounts(eventContext[amountKey]) >= equalizeAmounts(thresholdAmount);
};

const evaluateWithdrawal = (parameterValue, eventContext) => {
    const timeThreshold = moment(parseInt(parameterValue, 10));
    const timeSettled = moment(parseInt(eventContext.timeInMillis, 10));
    logger('Checking if withdrawal is occurring before: ', timeThreshold, ' vs withdrawal time: ', timeSettled);
    return timeSettled.isBefore(timeThreshold);
};

const evaluateGameResponse = (eventContext, parameterValue) => {
    const { numberTaps, timeTakenMillis } = eventContext;
    const [requiredTaps, maxTimeMillis] = parameterValue.split('::');
    return numberTaps >= requiredTaps && timeTakenMillis <= maxTimeMillis;
};

const gameResponseFilter = (logContext, maxTimeMillis) => logContext && logContext.numberTaps && logContext.timeTakenMillis <= maxTimeMillis;

const evaluateGameTournament = (event, parameterValue) => {
    const [selectTop, maxTimeMillis] = parameterValue.split('::');
    
    const { accountId, eventContext } = event;
    if (!eventContext || !accountId) {
        return false;
    }

    const { accountTapList } = event.eventContext;
    const withinTimeList = accountTapList.filter((response) => gameResponseFilter(response.logContext, maxTimeMillis));
    const sortedList = withinTimeList.sort((response1, response2) => response2.logContext.numberTaps - response1.logContext.numberTaps);
    logger('Evaluating game tournament results, sorted list: ', sortedList);

    const topList = sortedList.slice(0, selectTop).map((response) => response.accountId);
    logger('And top accounts: ', topList, ' checked against: ', event.accountId);
    return topList.includes(event.accountId);
};

const testCondition = (event, statusCondition) => {
    logger('Status condition: ', statusCondition);
    const conditionType = statusCondition.substring(0, statusCondition.indexOf(' '));
    const parameterMatch = statusCondition.match(/#{(.*)}/);
    const parameterValue = parameterMatch ? parameterMatch[1] : null;
    logger('Parameter value: ', parameterValue);
    const eventHasContext = typeof event.eventContext === 'object';
    
    const { eventType, eventContext } = event;

    // these two lines ensure we do not get caught in infinite loops because of boost/messages publishing, and that we only check the right events for the right conditions
    const isEventTriggeredButForbidden = (conditionType === 'event_occurs' && (eventType.startsWith('BOOST') || eventType.startsWith('MESSAGE')));
    const isNonEventTriggeredButForbidden = (conditionType !== 'event_occurs' && (!util.EVENT_TYPE_CONDITION_MAP[eventType] || !util.EVENT_TYPE_CONDITION_MAP[eventType].includes(conditionType)));
    if (isEventTriggeredButForbidden || isNonEventTriggeredButForbidden) {
        return false;
    }
    
    switch (conditionType) {
        case 'save_event_greater_than':
            logger('Save event greater than, param value amount: ', equalizeAmounts(parameterValue), ' and amount from event: ', equalizeAmounts(eventContext.savedAmount));
            return safeEvaluateAbove(eventContext, 'savedAmount', parameterValue) && currency(eventContext.savedAmount) === currency(parameterValue);
        case 'save_completed_by':
            logger(`Checking if save completed by ${event.accountId} === ${parameterValue}, result: ${event.accountId === parameterValue}`);
            return event.accountId === parameterValue;
        case 'first_save_by':
            return event.accountId === parameterValue && eventHasContext && eventContext.firstSave;
        case 'balance_below':
            logger('Checking balance below: ', equalizeAmounts(parameterValue), ' event context: ', equalizeAmounts(eventContext.newBalance));
            return equalizeAmounts(eventContext.newBalance) < equalizeAmounts(parameterValue);
        case 'withdrawal_before':
            return safeEvaluateAbove(eventContext, 'withdrawalAmount', 0) && evaluateWithdrawal(parameterValue, event.eventContext);
        case 'number_taps_greater_than':
            return evaluateGameResponse(eventContext, parameterValue);
        case 'number_taps_in_first_N':
            return evaluateGameTournament(event, parameterValue);
        case 'event_occurs':
            logger('Checking if event type matches paramater: ', eventType === parameterValue);
            return eventType === parameterValue;
        default:
            return false;
    }
};

module.exports.testConditionsForStatus = (event, statusConditions) => statusConditions.every((condition) => testCondition(event, condition));

module.exports.extractStatusChangesMet = (event, boost) => {
    const statusConditions = boost.statusConditions;
    return Object.keys(statusConditions).filter((key) => testConditionsForStatus(event, statusConditions[key]));
};
