'use strict';

const logger = require('debug')('jupiter:boost:condition-tester');
const moment = require('moment');

const util = require('ops-util-common');

// by far the most common and plentiful at present
const SAVE_CONDITIONS = [
    'save_event_greater_than',
    'save_completed_by',
    'first_save_by',
    'first_save_above',
    'save_tagged_with',
    'balance_crossed_major_digit',
    'balance_crossed_abs_target'
];

const EVENT_BASED_CONDITIONS = [
    'event_occurs',
    'event_does_follow',
    'event_does_not_follow'
];

const EVENT_TYPE_CONDITION_MAP = {
    'SAVING_PAYMENT_SUCCESSFUL': SAVE_CONDITIONS,
    'WITHDRAWAL_EVENT_CONFIRMED': ['balance_below', 'withdrawal_before'],
    'USER_GAME_COMPLETION': ['number_taps_greater_than', 'percent_destroyed_above'],
    'BOOST_EXPIRED': ['number_taps_in_first_N', 'percent_destroyed_in_first_N', 'randomly_chosen_first_N'],
    'FRIEND_REQUEST_INITIATED_ACCEPTED': ['friends_added_since', 'total_number_friends'],
    'FRIEND_REQUEST_TARGET_ACCEPTED': ['friends_added_since', 'total_number_friends']
};

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

const evaluateCrossedDigit = (parameterValue, eventContext) => {
    logger('Evaluating if crossed major level, vs threshold, param value: ', parameterValue, ' event context: ', eventContext);
    if (equalizeAmounts(parameterValue) > equalizeAmounts(eventContext.postSaveBalance)) {
        return false;
    }

    const postSaveBalance = util.convertAmountStringToDict(eventContext.postSaveBalance);
    const preSaveBalance = util.convertAmountStringToDict(eventContext.preSaveBalance);

    // if the post save balance is above the next level for the pre save balance, then that level was crossed
    const preSaveLevelUp = util.findNearestMajorDigit(preSaveBalance, postSaveBalance.unit);
    logger('Next major level pre save: ', preSaveLevelUp, ' is new balance at or above ? : ', postSaveBalance.amount >= preSaveLevelUp);

    return postSaveBalance.amount >= preSaveLevelUp;
};

const evaluateCrossedTarget = (parameterValue, eventContext) => (
    safeEvaluateAbove(eventContext, 'postSaveBalance', parameterValue) &&
    typeof eventContext.preSaveBalance === 'string' &&
    !safeEvaluateAbove(eventContext, 'preSaveBalance', parameterValue) 
);

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
    // logger('Evaluating game tournament results, sorted list: ', sortedList);

    const topList = sortedList.slice(0, selectTop).map((response) => response.accountId);
    // logger('Tournament top accounts: ', topList, ' checked against the account ID in this event: ', event.accountId);
    return topList.includes(event.accountId);
};

const evaluateRandomAward = (event, parameterValue, eventContext) => {
    const selectTop = parameterValue;

    const accountSorter = (accountA, accountB) => Object.values(accountB)[0] - Object.values(accountA)[0];
    const sortedList = eventContext.accountScoreList.sort(accountSorter);
    // logger('Sorted recipeients:', sortedList)

    const topList = sortedList.slice(0, selectTop).map((scoredAccount) => Object.keys(scoredAccount)[0]);
    // logger('Got top scorers:', topList)
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

const extractTaggedBoosts = (eventContext) => (
    eventContext && eventContext.transactionTags 
        ? eventContext.transactionTags.filter((tag) => tag.startsWith('BOOST::')).map((tag) => tag.substring('BOOST::'.length)) : []
);

const checkBoostTagged = (parameterValue, boostTags, boostId) => {
    const soughtBoostId = parameterValue === 'THIS_BOOST' ? boostId : parameterValue;
    return boostTags.includes(soughtBoostId);
};

// todo : think through fully earliest/latest, combinations, etc. (e.g., will need boost-account creation time)
// (e.g., if save twice in period and then withdraw at 61 days from first save but 10 from second save) - use tests
const eventSorter = (eventA, eventB) => eventA.timestamp - eventB.timestamp; // since in millis

const checkEventDoesNotFollow = (parameterValue, eventContext) => {
    if (!eventContext || !eventContext.eventHistory) {
        return false; // in case this gets called somewhere that isn't expecting to provide history
    }

    const [firstEventType, secondEventType, timeAmount, timeUnit] = parameterValue.split('::');
    const eventHistory = eventContext.eventHistory.sort(eventSorter);
    const firstOccurenceOfFirstType = eventHistory.find((event) => event.eventType === firstEventType);
    if (!firstOccurenceOfFirstType) {
        return false; // because by definition has not passed
    }

    const thresholdTime = moment(firstOccurenceOfFirstType.timestamp).add(parseInt(timeAmount, 10), timeUnit);

    const firstOccurenceOfSecondType = eventHistory.find((event) => event.eventType === secondEventType);    
    if (!firstOccurenceOfSecondType) {
        return moment().isAfter(thresholdTime);
    }

    return moment(firstOccurenceOfSecondType.timestamp).isAfter(thresholdTime);
};

const checkEventFollows = (parameterValue, eventContext) => {
    if (!eventContext || !eventContext.eventHistory) {
        return false; // as above
    }

    const [firstEventType, secondEventType, timeAmount, timeUnit] = parameterValue.split('::');
    const eventHistory = eventContext.eventHistory.sort(eventSorter);
    
    const firstOccurenceOfFirstType = eventHistory.find((event) => event.eventType === firstEventType);
    logger('Checking for first occurrence of ', firstEventType, ' found: ', firstOccurenceOfFirstType);
    if (!firstOccurenceOfFirstType) {
        logger('Initiating event not found, so exiting');
        return false; // because by definition has not passed
    }

    const thresholdTime = moment(firstOccurenceOfFirstType.timestamp).add(parseInt(timeAmount, 10), timeUnit);

    const firstOccurenceOfSecondType = eventHistory.find((event) => event.eventType === secondEventType);    
    logger('Now, second type, checking for first occurrence of ', secondEventType, ' found: ', firstOccurenceOfSecondType);
    if (!firstOccurenceOfSecondType) {
        logger('Second event not found, so exiting');
        return false; // by definition
    }

    return moment(firstOccurenceOfSecondType.timestamp).isBefore(thresholdTime);
};

// this one is always going to be complex -- in time maybe split out the switch block further
// eslint-disable-next-line complexity
module.exports.testCondition = (event, statusCondition) => {
    // logger('Testing status condition: ', statusCondition);
    if (typeof statusCondition !== 'string') {
        return false;
    }
    
    const conditionType = statusCondition.substring(0, statusCondition.indexOf(' '));
    const parameterMatch = statusCondition.match(/#{(.*)}/);
    const parameterValue = parameterMatch ? parameterMatch[1] : null;
    const eventHasContext = typeof event.eventContext === 'object';
    
    const { eventType, eventContext, boostId } = event;

    // these two lines ensure we do not get caught in infinite loops because of boost/messages publishing, and that we only check the right events for the right conditions
    const isEventCondition = EVENT_BASED_CONDITIONS.includes(conditionType);
    const isEventTriggeredButForbidden = (isEventCondition && (eventType.startsWith('BOOST') || eventType.startsWith('MESSAGE')));   
    
    const isConditionAndEventTypeForbidden = !EVENT_TYPE_CONDITION_MAP[eventType] || !EVENT_TYPE_CONDITION_MAP[eventType].includes(conditionType);
    const isNonEventTriggeredButForbidden = !isEventCondition && isConditionAndEventTypeForbidden;
    
    if (isEventTriggeredButForbidden || isNonEventTriggeredButForbidden) {
        return false;
    }

    const transactionBoostTags = extractTaggedBoosts(eventContext);
    const isTxForOtherBoost = transactionBoostTags.length > 0 && !transactionBoostTags.includes(boostId);
    if (isTxForOtherBoost) {
        logger('Transaction had tags: ', eventContext.transactionTags, ' and this boost ID: ', boostId, ' so must be for another');
        return false;
    }
    
    switch (conditionType) {
        // save and balance conditions
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
        case 'balance_crossed_major_digit':
            return evaluateCrossedDigit(parameterValue, eventContext);
        case 'balance_crossed_abs_target':
            return evaluateCrossedTarget(parameterValue, eventContext);
        
        // game conditions
        case 'number_taps_greater_than':
            return evaluateGameResponse(eventContext, parameterValue, 'numberTaps');
        case 'number_taps_in_first_N':
            return evaluateGameTournament(event, parameterValue, 'numberTaps');
        case 'percent_destroyed_above':
            return evaluateGameResponse(eventContext, parameterValue, 'percentDestroyed');
        case 'percent_destroyed_in_first_N':
            return evaluateGameTournament(event, parameterValue, 'percentDestroyed');
        case 'randomly_chosen_first_N':
            return evaluateRandomAward(event, parameterValue, eventContext);
        
        // social conditions
        case 'friends_added_since':
            return evaluateFriendsSince(parameterValue, eventContext.friendshipList);
        case 'total_number_friends':
            return evaluateTotalFriends(parameterValue, eventContext.friendshipList);
        
        // specific tag conditions
        case 'save_tagged_with':
            logger('Checking if tagged, have tx tags: ', transactionBoostTags);
            return checkBoostTagged(parameterValue, transactionBoostTags, boostId);
        
        // event trigger conditions
        case 'event_occurs':
            logger('Checking if event type matches parameter: ', eventType === parameterValue);
            return eventType === parameterValue;
        case 'event_does_not_follow':
            return checkEventDoesNotFollow(parameterValue, eventContext);
        case 'event_does_follow':
            return checkEventFollows(parameterValue, eventContext);

        default:
            logger('Condition type not supported yet');
            return false;
    }
};

module.exports.testConditionsForStatus = (eventParameters, statusConditions) => statusConditions.
    every((condition) => exports.testCondition(eventParameters, condition));

module.exports.extractStatusChangesMet = (event, boost) => {
    const statusConditions = boost.statusConditions;
    const eventParameters = { boostId: boost.boostId, ...event };
    return Object.keys(statusConditions).filter((key) => exports.testConditionsForStatus(eventParameters, statusConditions[key]));
};
