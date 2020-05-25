'use strict';

const logger = require('debug')('jupiter:boost:condition-tester');
const moment = require('moment');

const { EVENT_TYPE_CONDITION_MAP } = require('./boost.util');

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

const evaluateGameResponse = (eventContext, parameterValue, responseValueKey) => {
    const { timeTakenMillis } = eventContext;
    const valueToCheck = eventContext[responseValueKey];
    const [requiredThreshold, maxTimeMillis] = parameterValue.split('::');
    logger('Checking if ', valueToCheck, ' is above ', requiredThreshold);
    return valueToCheck >= requiredThreshold && timeTakenMillis <= maxTimeMillis;
};

const gameResponseFilter = (logContext, maxTimeMillis, responseValueKey) => ( 
    logContext && logContext[responseValueKey] && logContext.timeTakenMillis <= maxTimeMillis
);

const evaluateGameTournament = (event, parameterValue, responseValueKey) => {
    const [selectTop, maxTimeMillis] = parameterValue.split('::');
    
    const { accountId, eventContext } = event;
    if (!eventContext || !accountId) {
        return false;
    }

    const { accountScoreList } = event.eventContext;
    const withinTimeList = accountScoreList.filter((response) => gameResponseFilter(response.logContext, maxTimeMillis, responseValueKey));
    
    const scoreSorter = (response1, response2) => response2.logContext[responseValueKey] - response1.logContext[responseValueKey];
    const sortedList = withinTimeList.sort(scoreSorter);
    logger('Evaluating game tournament results, sorted list: ', sortedList);

    const topList = sortedList.slice(0, selectTop).map((response) => response.accountId);
    logger('Tournament top accounts: ', topList, ' checked against: ', event.accountId);
    return topList.includes(event.accountId);
};

const evaluateFriendsSince = (parameterValue, friendshipList) => {
    const [targetNumber, sinceTimeMillis] = parameterValue.split('::');
    logger('Checking for ', targetNumber, ' friends since ', sinceTimeMillis, ' in list: ', friendshipList);
    const friendsSinceTime = friendshipList.filter((friendship) => friendship.creationTimeMillis > sinceTimeMillis);
    return friendsSinceTime.length >= targetNumber;
};

const evaluateTotalFriends = (parameterValue, friendshipList) => {
    const [targetNumber, relationshipConstraint] = parameterValue.split('::');
    logger('Checking for ', targetNumber, ' friends in total, with constraint ', relationshipConstraint);
    const filterToApply = (friendship) => relationshipConstraint === 'EITHER' || friendship.userInitiated;
    const numberFriends = friendshipList.filter(filterToApply);
    return numberFriends.length >= targetNumber;
};

// this one is always going to be complex -- in time maybe split out the switch block further
// eslint-disable-next-line complexity
module.exports.testCondition = (event, statusCondition) => {
    logger('Status condition: ', statusCondition);
    const conditionType = statusCondition.substring(0, statusCondition.indexOf(' '));
    const parameterMatch = statusCondition.match(/#{(.*)}/);
    const parameterValue = parameterMatch ? parameterMatch[1] : null;
    logger('Parameter value: ', parameterValue);
    const eventHasContext = typeof event.eventContext === 'object';
    
    const { eventType, eventContext } = event;

    // these two lines ensure we do not get caught in infinite loops because of boost/messages publishing, and that we only check the right events for the right conditions
    const isEventTriggeredButForbidden = (conditionType === 'event_occurs' && (eventType.startsWith('BOOST') || eventType.startsWith('MESSAGE')));
    
    const isConditionAndEventTypeForbidden = !EVENT_TYPE_CONDITION_MAP[eventType] || !EVENT_TYPE_CONDITION_MAP[eventType].includes(conditionType);
    const isNonEventTriggeredButForbidden = conditionType !== 'event_occurs' && isConditionAndEventTypeForbidden;
    
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
        case 'first_save_above':
            return eventContext.firstSave && eventContext.saveCount === 1 && safeEvaluateAbove(eventContext, 'savedAmount', parameterValue);
        case 'balance_below':
            logger('Checking balance below: ', equalizeAmounts(parameterValue), ' event context: ', equalizeAmounts(eventContext.newBalance));
            return equalizeAmounts(eventContext.newBalance) < equalizeAmounts(parameterValue);
        case 'withdrawal_before':
            return safeEvaluateAbove(eventContext, 'withdrawalAmount', 0) && evaluateWithdrawal(parameterValue, event.eventContext);
        // game conditions
        case 'number_taps_greater_than':
            return evaluateGameResponse(eventContext, parameterValue, 'numberTaps');
        case 'number_taps_in_first_N':
            return evaluateGameTournament(event, parameterValue, 'numberTaps');
        case 'percent_destroyed_above':
            return evaluateGameResponse(eventContext, parameterValue, 'percentDestroyed');
        case 'percent_destroyed_in_first_N':
            return evaluateGameTournament(event, parameterValue, 'percentDestroyed');
        // social conditions
        case 'friends_added_since':
            return evaluateFriendsSince(parameterValue, eventContext.friendshipList);
        case 'total_number_friends':
            return evaluateTotalFriends(parameterValue, eventContext.friendshipList);
        // event trigger conditions
        case 'event_occurs':
            logger('Checking if event type matches paramater: ', eventType === parameterValue);
            return eventType === parameterValue;
        default:
            logger('Condition type not supported yet');
            return false;
    }
};

module.exports.testConditionsForStatus = (event, statusConditions) => statusConditions.every((condition) => exports.testCondition(event, condition));

module.exports.extractStatusChangesMet = (event, boost) => {
    const statusConditions = boost.statusConditions;
    return Object.keys(statusConditions).filter((key) => exports.testConditionsForStatus(event, statusConditions[key]));
};
