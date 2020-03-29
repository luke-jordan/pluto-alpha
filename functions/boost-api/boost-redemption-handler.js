'use strict';

const stringify = require('json-stable-stringify');

const publisher = require('publish-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });


// note: only has to deal with two cases at the moment:
// either the redemption is made just for the user in question, or for the whole target of the boost, but the latter
// is only possible on 'INDIVIDUAL' or 'GROUP' boosts (eg in the case of referrals, later on, friend saving
// const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

const extractPendingAccountsAndUserIds = async (initiatingAccountId, boosts) => {
    const selectPromises = boosts.map((boost) => {
        const redeemsAll = boost.flags && boost.flags.indexOf('REDEEM_ALL_AT_ONCE') >= 0;
        const restrictToInitiator = boost.boostAudienceType === 'GENERAL' || !redeemsAll;
        const findAccountsParams = { boostIds: [boost.boostId], status: util.ACTIVE_BOOST_STATUS };
        if (restrictToInitiator) {
            findAccountsParams.accountIds = [initiatingAccountId];
        }
        logger('Assembled params: ', findAccountsParams);
        try {
            return persistence.findAccountsForBoost(findAccountsParams);
        } catch (err) {
            logger('FATAL_ERROR:', err);
            return { };
        }
    });

    const affectedAccountArray = await Promise.all(selectPromises);
    logger('Affected accounts: ', affectedAccountArray);
    return affectedAccountArray.map((result) => result[0]).
        reduce((obj, item) => ({ ...obj, [item.boostId]: item.accountUserMap }), {});
};

// note: this is only called for redeemed boosts, by definition. also means it is 'settled' by definition. it redeemes, no matter prior status
// further note: if this is a revocation, the negative will work as required on sums, but test the hell out of this (and viz transfer-handler)
const generateFloatTransferInstructions = (affectedAccountDict, boost, revoke = false) => {
    const recipientAccounts = Object.keys(affectedAccountDict[boost.boostId]);
    // let recipients = recipientAccounts.reduce((obj, recipientId) => ({ ...obj, [recipientId]: boost.boostAmount }), {});
    const amount = revoke ? -boost.boostAmount : boost.boostAmount;
    const transactionType = revoke ? 'BOOST_REVERSAL' : 'BOOST_REDEMPTION';
    const recipients = recipientAccounts.map((recipientId) => ({ 
        recipientId, amount, recipientType: 'END_USER_ACCOUNT'
    }));
    return {
        floatId: boost.fromFloatId,
        fromId: boost.fromBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: boost.boostCurrency,
        unit: boost.boostUnit,
        identifier: boost.boostId,
        relatedEntityType: 'BOOST_REDEMPTION',
        allocType: transactionType, // for float allocation
        allocState: 'SETTLED',
        transactionType, // for matching account records
        settlementStatus: 'SETTLED',
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
    };

    const wholeCurrencyAmount = boost.boostAmount / unitDivisors[boost.boostUnit];
    const formattedBoostAmount = numberFormat.format(wholeCurrencyAmount);
    
    // logger('Formatted boost amount, whole currency: ', formattedBoostAmount);

    return {
        instructionId,
        destinationUserId,
        parameters: { boostAmount: formattedBoostAmount },
        triggerBalanceFetch: true
    };
};

const assembleMessageForInstruction = (boost, boostInstruction, affectedAccountUserDict) => {
    const target = boostInstruction.accountId;
    const instructionId = boostInstruction.msgInstructionId;

    logger(`Generating message for target ${target} and instruction ID ${instructionId}`);

    if (target === 'ALL') {
        // generate messages for all the users
        return Object.values(affectedAccountUserDict).
            map((userObject) => generateMsgInstruction(instructionId, userObject.userId, boost));
    } else if (Reflect.has(affectedAccountUserDict, target)) {
        // generate messages for just this user
        const userObjectForTarget = affectedAccountUserDict[target];
        logger('user object for target: ', userObjectForTarget);
        const userMsgInstruction = generateMsgInstruction(instructionId, userObjectForTarget.userId, boost);
        logger('Generated instruction: ', userMsgInstruction);
        return [userMsgInstruction];
    }
    
    logger('Target not present in user dict, investigate');
    return [];
};

const assembleMessageInstructions = (boost, affectedAccountUserDict) => {
    const boostMessageInstructions = boost.messageInstructions;
    logger('Boost msg instructions: ', boostMessageInstructions);
    logger('Affected account dict: ', affectedAccountUserDict);
    const assembledMessages = [];
    // todo : make work for other statuses
    boostMessageInstructions.
        filter((entry) => entry.status === 'REDEEMED').
        forEach((entry) => {
            const thisEntryInstructions = assembleMessageForInstruction(boost, entry, affectedAccountUserDict);
            logger('Got this back: ', thisEntryInstructions);
            assembledMessages.push(...thisEntryInstructions);
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
    const eventType = `BOOST_REDEEMED`;
    logger('WTF: ', event.eventContext);
    const publishPromises = Object.keys(affectedAccountsUserDict).map((accountId) => {
        const initiator = affectedAccountsUserDict[event.accountId]['userId'];
        const context = {
            accountId,
            boostId: boost.boostId,
            boostType: boost.boostType,
            boostCategory: boost.boostCategory,
            boostUpdateTimeMillis: boostUpdateTime.valueOf(),
            boostAmount: `${boost.boostAmount}::${boost.boostUnit}::${boost.boostCurrency}`,
            transferResults,
            triggeringEventContext: event.eventContext
        };
        return publisher.publishUserEvent(affectedAccountsUserDict[accountId]['userId'], eventType, { initiator, context });
    });

    logger('Publish result: ', publishPromises);
    return publishPromises;
};

export async function redeemOrRevokeBoosts(boostsToRedeem, boostsToRevoke, affectedAccountsDict) {

    logger('Boosts to redeem: ', boostsToRedeem);
    const redeemInstructions = boostsToRedeem.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost));
    logger('***** Transfer instructions: ', redeemInstructions);

    const revokeInstructions = boostsToRevoke.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost, true));
    logger('***** Revoke instructions: ', revokeInstructions);

    const transferInstructions = redeemInstructions.concat(revokeInstructions);
    const resultOfTransfers = await (transferInstructions.length === 0 ? {} : triggerFloatTransfers(transferInstructions));
    logger('Result of transfers: ', resultOfTransfers);

    // then: construct & send redemption messages
    const messageInstructionsNested = boostsToRedeem.map((boost) => assembleMessageInstructions(boost, affectedAccountsDict[boost.boostId]));
    const messageInstructionsFlat = Reflect.apply([].concat, [], messageInstructionsNested);
    logger('Passing message instructions: ', messageInstructionsFlat);
    
    // then: assemble the event publishing
    let finalPromises = [];
    if (messageInstructionsFlat.length > 0) {
        const messageInvocation = generateMessageSendInvocation(messageInstructionsFlat);
        logger('Message invocation: ', messageInvocation);
        const messagePromise = lambda.invoke(messageInvocation).promise();
        logger('Obtained message promise');
        finalPromises.push(messagePromise);
    }

    const boostsRedeemedIds = boostsToRedeem.map((boost) => boost.boostId);
    if (boostsRedeemedIds.length > 0) {
        const updateRedeemedAmount = persistence.updateBoostAmountRedeemed(boostsRedeemedIds);
        finalPromises.push(updateRedeemedAmount);
    }
    
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

    return resultOfTransfers;
}
