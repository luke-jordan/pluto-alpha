'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
// const moment = require('moment');
const stringify = require('json-stable-stringify');
const status = require('statuses');

const persistence = require('./persistence/rds.boost');
const publisher = require('publish-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region' )});

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;
const extractUserDetails = (event) => event.requestContext ? event.requestContext.authorizer : null;

const handleError = (err) => {
    logger('FATAL_ERROR: ', err);
    return { statusCode: status('Internal Server Error'), body: JSON.stringify(err.message) };
}

////////////////////////////// HELPER METHODS ///////////////////////////////////////////

// this takes the event and creates the arguments to pass to persistence to get applicable boosts
const extractFindBoostKey = (event) => {
    const persistenceKey = event.accountId ? { accountId: [event.accountId] } : { userId: [event.userId] };
    persistenceKey.boostStatus = ['OFFERED', 'PENDING'];
    persistenceKey.active = true;
    return persistenceKey;
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

const testCondition = (event, statusCondition) => {
    logger('Status condition: ', statusCondition);
    const conditionType = statusCondition.substring(0, statusCondition.indexOf(' '));
    logger('Condition type: ', conditionType);
    const parameterMatch = statusCondition.match(/#{(.*)}/);
    const parameterValue = parameterMatch ? parameterMatch[1] : null;
    logger('Parameter value: ', parameterValue);
    const eventHasContext = typeof event.eventContext === 'object';
    switch (conditionType) {
        case 'save_event_greater_than':
            // todo : check for same currency ...
            logger('Save event greater than, param value amount: ', equalizeAmounts(parameterValue));
            logger('And amount from event: ', equalizeAmounts(event.eventContext.savedAmount));
            return equalizeAmounts(event.eventContext.savedAmount) >= equalizeAmounts(parameterValue);
        case 'save_completed_by':
            return event.accountId === parameterValue;
        case 'first_save_by':
            return event.accountId === parameterValue && eventHasContext && event.eventContext.firstSave;
        default:
            return false;
    }
};

const testConditionsForStatus = (event, statusConditions) => statusConditions.every((condition) => testCondition(event, condition));

const extractStatusChangesMet = (event, boost) => {
    const statusConditions = boost.statusConditions;
    return Object.keys(statusConditions).filter((key) => testConditionsForStatus(event, statusConditions[key]));
};

// note: only has to deal with two cases at the moment:
// either the redemption is made just for the user in question, or for the whole target of the boost, but the latter
// is only possible on 'INDIVIDUAL' or 'GROUP' boosts (eg in the case of referrals, later on, friend saving
// const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

const extractPendingAccountsAndUserIds = async (initiatingAccountId, boosts) => {
    const selectPromises = boosts.map((boost) => {
        const redeemsAll = boost.flags && boost.flags.indexOf('REDEEM_ALL_AT_ONCE') != -1;
        const restrictToInitiator = boost.boostAudience === 'GENERAL' || !redeemsAll;
        const findAccountsParams = { boostIds: [boost.boostId], status: ['PENDING'] };
        if (restrictToInitiator) {
            findAccountsParams.accountIds = [initiatingAccountId];
        }
        logger('Assembled params: ', findAccountsParams);
        return persistence.findAccountsForBoost(findAccountsParams);
    });

    const affectedAccountArray = await Promise.all(selectPromises);
    logger('Affected accounts: ', affectedAccountArray);
    return affectedAccountArray.map((result) => result[0]).
        reduce((obj, item) => ({ ...obj, [item.boostId]: item.accountUserMap }), {});
}

// note: this is only called for redeemed boosts, by definition
const generateFloatTransferInstructions = (affectedAccountDict, boost) => {
    let recipientAccounts = Object.keys(affectedAccountDict[boost.boostId]);
    // let recipients = recipientAccounts.reduce((obj, recipientId) => ({ ...obj, [recipientId]: boost.boostAmount }), {});
    let recipients = recipientAccounts.map(recipientId => ({ 
        recipientId, amount: boost.boostAmount, recipientType: 'END_USER_ACCOUNT'
    }));
    return {
        floatId: boost.fromFloatId,
        fromId: boost.fromBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: boost.boostCurrency,
        unit: boost.boostUnit,
        identifier: boost.boostId,
        relatedEntityType: 'BOOST_REDEMPTION',
        recipients
    };
};

const triggerFloatTransfers = async (transferInstructions) => {
    const lambdaInvocation = {
        FunctionName: config.get('lambdas.floatTransfer'),
        InvocationType: 'RequestResponse',
        Payload: stringify({ instructions: transferInstructions })
    };

    logger('Invoking allocation lambda with: ', lambdaInvocation);
    const result = await lambda.invoke(lambdaInvocation).promise();
    logger('Float transfer lambda returned: ', result);

    const resultOfTransfer = JSON.parse(result.Payload);
    if (resultOfTransfer.statusCode !== 200) {
        // todo : DLQ !!! very necessary
        logger('TRANSFER_ERROR: see above for lambda result, triggered by instruction: ', transferInstructions);
        throw new Error('Error completing float transfers');
    }

    return JSON.parse(resultOfTransfer.body);
};

const generateUpdateInstructions = (alteredBoosts, boostStatusChangeDict, affectedAccountsUsersDict, transactionId) => {
    return alteredBoosts.map((boost) => {
        const boostId = boost.boostId;
        const highestStatus = boostStatusChangeDict[boostId][0]; // but needs a sort
        const isChangeRedemption = highestStatus === 'REDEEMED';
        const appliesToAll = boost.flags && boost.flags.indexOf('REDEEM_ALL_AT_ONCE') != -1;
        const logContext = { newStatus: highestStatus, transactionId };
        return {
            boostId,
            accountIds: Object.keys(affectedAccountsUsersDict[boostId]),
            newStatus: highestStatus,
            stillActive: !(isChangeRedemption && appliesToAll),
            logType: 'STATUS_CHANGE',
            logContext
        };
    });
};

const generateMsgInstruction = (instructionId, destinationUserId, boost) => {
    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: boost.boostCurrency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    });

    const unitDivisors = {
        'HUNDREDTH_CENT': 100 * 100,
        'WHOLE_CENT': 100,
        'WHOLE_CURRENCY': 1 
    }

    const wholeCurrencyAmount = boost.boostAmount / unitDivisors[boost.boostUnit];
    const formattedBoostAmount = numberFormat.format(wholeCurrencyAmount);
    
    // logger('Formatted boost amount, whole currency: ', formattedBoostAmount);

    return {
        instructionId,
        destinationUserId,
        parameters: { boostAmount: formattedBoostAmount },
        triggerBalanceFetch: true
    }
};

const assembleMessageInstructions = (boost, affectedAccountUserDict) => {
    const boostMessageInstructions = boost.messageInstructionIds;
    logger('Boost msg instructions: ', boostMessageInstructions);
    let assembledMessages = [];
    // todo : make work for other statuses
    boostMessageInstructions.
        filter((entry) => entry.status === 'REDEEMED').
        forEach((entry) => {
            const target = entry.accountId;
            const instructionId = entry.msgInstructionId;
            if (target === 'ALL') {
                const messages = Object.values(affectedAccountUserDict).map((userId) => generateMsgInstruction(instructionId, userId, boost));
                assembledMessages.push(...messages);
            } else if (Reflect.has(affectedAccountUserDict, target)) {
                const userIdForTarget = affectedAccountUserDict[target];
                assembledMessages.push(generateMsgInstruction(instructionId, userIdForTarget, boost));
            }
    });
    logger('Assembled messages: ', assembledMessages);

    return assembledMessages;
};

const generateMessageSendInvocation = (messageInstructions) => ({
    FunctionName: config.get('lambdas.messageSend'),
    InvocationType: 'Event',
    Payload: stringify({ instructions: messageInstructions })
});

const createPublishEventPromises = ({ boost, boostUpdateTime, affectedAccountsUserDict, transferResults, event }) => {
    const eventType = `${boost.boostType}_REDEEMED`;
    const publishPromises = Object.keys(affectedAccountsUserDict).map((accountId) => {
        const initiator = affectedAccountsUserDict[event.accountId];
        const context = {
            boostId: boost.boostId,
            boostUpdateTimeMillis: boostUpdateTime.valueOf(),
            transferResults,
            eventContext: event.eventContext
        }
        return publisher.publishUserEvent(affectedAccountsUserDict[accountId], eventType, { initiator, context });
    });

    logger('Publish result: ', publishPromises);
    return publishPromises;
};

// note: possibly in time we can put this on an SQS queue, for now using a somewhat
// generic handler for any boost relevant response (add cash, solve game, etc)
module.exports.processEvent = async (event) => {
    logger('Processing boost event: ', event);

    // first, we check if there is a pending boost for this account, or user, if we only have that
    if (!event.accountId && !event.userId) {
        return { statusCode: status('Bad request'), body: 'Function requires at least a user ID or accountID' };
    }

    const offeredOrPendingBoosts = await persistence.findBoost(extractFindBoostKey(event));
    // logger('Found these open boosts: ', offeredOrPendingBoosts);

    if (!offeredOrPendingBoosts || offeredOrPendingBoosts.length === 0) {
        logger('Well, nothing found');
        return { statusCode: status('Ok'), body: JSON.stringify({ boostsTriggered: 0 })};
    }

    // for each offered or pending boost, we check if the event triggers a status change, and hence compose an object
    // whose keys are the boost IDs and whose values are the lists of statuses whose conditions have been met
    const boostStatusChangeDict = { };
    offeredOrPendingBoosts.forEach((boost) => {
        boostStatusChangeDict[boost.boostId] = extractStatusChangesMet(event, boost);
    });
    logger('Status change dict: ', boostStatusChangeDict);
    
    const boostsForStatusChange = offeredOrPendingBoosts.filter((boost) => boostStatusChangeDict[boost.boostId].length !== 0);
    // logger('These boosts were triggered: ', boostsForStatusChange);

    if (!boostsForStatusChange || boostsForStatusChange.length === 0) {
        logger('Boosts found, but none triggered to change, so exiting');
        return { statusCode: status('Ok'), body: JSON.stringify({ boostsTriggered: 0 })};
    }

    logger('At least one boost was triggered. First step is to extract affected accounts, then tell the float to transfer from bonus pool');
    const affectedAccountsDict = await extractPendingAccountsAndUserIds(event.accountId, boostsForStatusChange);
    logger('Retrieved affected accounts and user IDs: ', affectedAccountsDict);

    // first, do the float allocations. we do not parallel process this as if it goes wrong we should not proceed
    // todo : definitely need a DLQ for this guy
    const boostsToRedeem = boostsForStatusChange.filter((boost) => boostStatusChangeDict[boost.boostId].indexOf('REDEEMED') != -1);
    logger('Boosts to redeem: ', boostsToRedeem);
    const transferInstructions = boostsToRedeem.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost));
    logger('***** Transfer instructions: ', JSON.stringify(transferInstructions));
    
    const resultOfTransfers = await (transferInstructions.length === 0 ? {} : triggerFloatTransfers(transferInstructions));
    logger('Result of transfers: ', resultOfTransfers);

    // then we update the statuses of the boosts to redeemed
    const updateInstructions = generateUpdateInstructions(boostsForStatusChange, boostStatusChangeDict, affectedAccountsDict, event.eventContext.transactionId);
    logger('Sending these update instructions to persistence: ', updateInstructions);
    const resultOfUpdates = await persistence.updateBoostAccountStatus(updateInstructions);
    logger('Result of update operation: ', resultOfUpdates);

    // then: construct & send redemption messages
    const messageInstructionsNested = boostsToRedeem.map((boost) => assembleMessageInstructions(boost, affectedAccountsDict[boost.boostId]));
    const messageInstructionsFlat = [].concat.apply([], messageInstructionsNested);
    logger('Passing message instructions: ', messageInstructionsFlat);
    
    const messagePromise = lambda.invoke(generateMessageSendInvocation(messageInstructionsFlat)).promise();
    logger('Obtained message promise');
    
    // then: assemble the event publishing
    let finalPromises = [messagePromise];

    boostsToRedeem.forEach((boost) => {
        const boostId = boost.boostId;
        const boostUpdateTime = (resultOfUpdates.filter((row) => row.boostId === boostId)[0]).updatedTime;
        finalPromises = finalPromises.concat(createPublishEventPromises({ 
            boost,
            boostUpdateTime,
            affectedAccountsUserDict: affectedAccountsDict[boostId],
            transferResults: resultOfTransfers[boostId],
            event
        }));
    });

    logger('Final promises: ', finalPromises);
    // then: fire all of them off, and we are done
    const resultOfFinalCalls = await Promise.all(finalPromises);
    logger('Result of final calls: ', resultOfFinalCalls);

    const resultToReturn = {
        result: 'SUCCESS',
        resultOfTransfers,
        resultOfUpdates
    }

    return {
        statusCode: 200,
        body: JSON.stringify(resultToReturn)
    };
};

module.exports.processUserBoostResponse = async (event) => {
    try {
        if (!event) {
            logger('Test run on lambda, exiting');
            return { statusCode: 400 };
        }
        
        const userDetails = extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: status('Forbidden') };
        }

        const params = extractEventBody(event);
        logger('Event params: ', params);

        return {
            statusCode: 200,
            body: JSON.stringify(params)
        };
        
    } catch (err) {
        return handleError(err);
    }
};