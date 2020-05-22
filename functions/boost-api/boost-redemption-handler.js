'use strict';

const logger = require('debug')('jupiter:boost:redemption');
const config = require('config');
const moment = require('moment');
const seedrandom = require('seedrandom');
const stringify = require('json-stable-stringify');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const DEFAULT_UNIT = 'HUNDREDTH_CENT';

const calculatePooledBoostAmount = (boost, userCount) => {
    const { poolContributionPerUser, percentPoolAsReward, additionalBonusToPool } = boost.rewardParameters;
    const contribAmount = opsUtil.convertToUnit(poolContributionPerUser.amount, poolContributionPerUser.unit, DEFAULT_UNIT);
    const bonusAmount = opsUtil.convertToUnit(additionalBonusToPool.amount, additionalBonusToPool.unit, DEFAULT_UNIT);    
    const calculatedBoostAmount = (userCount * contribAmount * percentPoolAsReward) + bonusAmount;
    return opsUtil.convertToUnit(calculatedBoostAmount, DEFAULT_UNIT, boost.boostUnit);
};

const generateMultiplier = (distribution) => {
    if (distribution === 'UNIFORM') {
        if (config.get('seedrandom.active')) {
            seedrandom(config.get('seedrandom.value'), { global: true });
        }
    
        return (Math.random()).toFixed(2);
    }
};

const calculateRandomBoostAmount = (boost) => {
    const { distribution, realizedRewardModuloZeroTarget } = boost.rewardParameters;
    const multiplier = generateMultiplier(distribution);
    let calculatedBoostAmount = multiplier * opsUtil.convertToUnit(boost.boostAmount, boost.boostUnit, DEFAULT_UNIT);
    while (calculatedBoostAmount % realizedRewardModuloZeroTarget > 0) {
        calculatedBoostAmount += 1000;
    }

    // Try again if the calculatedBoostAmount is rounded to a value greater than the boost amount
    if (calculatedBoostAmount > boost.boostAmount) {
        return calculateRandomBoostAmount(boost);
    }

    logger('Returning boost amt:', calculatedBoostAmount);
    return opsUtil.convertToUnit(calculatedBoostAmount, DEFAULT_UNIT, boost.boostUnit);
};

const calculateBoostAmount = (boost, pooledContributionMap) => {
    const rewardType = boost.rewardParameters.rewardType;
    const accountIds = pooledContributionMap[boost.boostId];
    if (rewardType === 'POOLED') {
        const userCount = accountIds.length;
        return calculatePooledBoostAmount(boost, userCount);
    }

    if (rewardType === 'RANDOM') {
        return calculateRandomBoostAmount(boost);
    }

    return boost.boostAmount;
};

const createPublishEventPromises = ({ boost, boostUpdateTime, affectedAccountsUserDict, transferResults, event, isRevocation }) => {
    const eventType = isRevocation ? 'BOOST_REVOKED' : 'BOOST_REDEEMED';
    logger('Affected accounts user dict: ', affectedAccountsUserDict);
    const publishPromises = Object.keys(affectedAccountsUserDict).map((accountId) => {
        const context = {
            accountId,
            boostId: boost.boostId,
            boostType: boost.boostType,
            boostCategory: boost.boostCategory,
            boostUpdateTimeMillis: boostUpdateTime.valueOf(),
            boostAmount: `${isRevocation ? -boost.boostAmount : boost.boostAmount}::${boost.boostUnit}::${boost.boostCurrency}`,
            transferResults,
            triggeringEventContext: event.eventContext
        };
        const options = { context };
        if (event.accountId && affectedAccountsUserDict[event.accountId]) {
            options.initiator = affectedAccountsUserDict[event.accountId]['userId'];
        }
        return publisher.publishUserEvent(affectedAccountsUserDict[accountId]['userId'], eventType, options);
    });

    logger('Publish result: ', publishPromises);
    return publishPromises;
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

const handleTransferToBonusPool = async (affectedAccountDict, boost, pooledContributionMap, event) => {
    const accountIds = pooledContributionMap[boost.boostId];
    if (accountIds.length === 0) {
        throw new Error('Error! No account ids for reward pool'); 
    }

    const poolContrib = boost.rewardParameters.poolContributionPerUser;
    const recipients = accountIds.map((recipientId) => ({
        recipientId, amount: -poolContrib.amount, recipientType: 'END_USER_ACCOUNT'
    }));

    const transferInstruction = {
        floatId: boost.fromFloatId,
        fromId: boost.fromBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: poolContrib.currency,
        unit: poolContrib.unit,
        identifier: boost.boostId,
        relatedEntityType: 'BOOST_REVERSAL',
        allocType: 'BOOST_REVERSAL', // for float allocation
        allocState: 'SETTLED',
        transactionType: 'BOOST_REVERSAL', // for matching account records
        settlementStatus: 'SETTLED',
        recipients
    };

    logger('Invoking bonus pool float transfer lambda with payload:', transferInstruction);
    const resultOfTransfer = await triggerFloatTransfers([transferInstruction]);
    logger('Result of transfer to bonus pool:', resultOfTransfer);

    const resultOfPublish = await Promise.all([createPublishEventPromises({
        boost: {
            boostId: boost.boostId,
            boostType: boost.boostType,
            boostCategory: boost.boostCategory,
            boostAmount: poolContrib.amount,
            boostUnit: poolContrib.unit,
            boostCurrency: poolContrib.currency
        },
        boostUpdateTime: moment().valueOf(),
        affectedAccountsUserDict: affectedAccountDict,
        transferResults: resultOfTransfer,
        event,
        isRevocation: true
    })]);

    logger('Result of publish:', resultOfPublish);

    return { resultOfTransfer, resultOfPublish };
};

// note: this is only called for redeemed boosts, by definition. also means it is 'settled' by definition. it redeemes, no matter prior status
// further note: if this is a revocation, the negative will work as required on sums, but test the hell out of this (and viz transfer-handler)
const generateFloatTransferInstructions = async (affectedAccountDict, boost, revoke, pooledContributionMap = {}, event = {}) => {
    const recipientAccounts = Object.keys(affectedAccountDict[boost.boostId]);
    // if pooled reward handle initial transfers from accounts to bonus pool
    if (boost.rewardParameters && boost.rewardParameters.rewardType === 'POOLED') {
        const resultOfInitialTransfer = await handleTransferToBonusPool(affectedAccountDict, boost, pooledContributionMap, event);
        logger('Result of initial transfer to bonus pool:', resultOfInitialTransfer);
    }

    // let recipients = recipientAccounts.reduce((obj, recipientId) => ({ ...obj, [recipientId]: boost.boostAmount }), {});
    const boostAmount = boost.rewardParameters ? calculateBoostAmount(boost, pooledContributionMap) : boost.boostAmount;
    const amount = revoke ? -boostAmount : boostAmount;
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
        relatedEntityType: transactionType,
        allocType: transactionType, // for float allocation
        allocState: 'SETTLED',
        transactionType, // for matching account records
        settlementStatus: 'SETTLED',
        recipients
    };
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
    if (!boostMessageInstructions) {
        return [];
    }

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

/**
 * Complicated thing in here is affectedAccountsDict. It stores, for each boost, the accounts whose statusses have been changed. Format:
 * The affectedAccountsDict has as its top level keys the boost IDs for the boosts that have been triggered.
 * The value of each entry is a map, referred to as accountUserMap, in which the keys are the accountIds that have been triggered,
 * and the value is the final dict, containing the userId of the owner of the account, and the _current_ (not the triggered) status
 * (to clarify the last -- if the user is in status PENDING, and has just fulfilled the conditions for REDEEMED, the status in the dict
 * will be PENDING) 
 */
module.exports.redeemOrRevokeBoosts = async ({ redemptionBoosts, revocationBoosts, affectedAccountsDict, pooledContributionMap, event }) => {
    const boostsToRedeem = redemptionBoosts || [];
    const boostsToRevoke = revocationBoosts || [];
    
    logger('Boosts to redeem: ', boostsToRedeem);
    const redeemInstructions = await Promise.all(boostsToRedeem.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost, false, pooledContributionMap, event)));
    logger('***** Transfer instructions: ', redeemInstructions);

    const revokeInstructions = await Promise.all(boostsToRevoke.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost, true)));
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
    
    const mapBoostToEventPublish = (boost, isRevocation) => createPublishEventPromises({ 
        boost,
        boostUpdateTime: moment().valueOf(), // could pass it along etc., but not worth the precision at this point
        affectedAccountsUserDict: affectedAccountsDict[boost.boostId],
        transferResults: resultOfTransfers[boost.boostId],
        event,
        isRevocation
    });

    finalPromises = finalPromises.concat(boostsToRedeem.map((boost) => mapBoostToEventPublish(boost, false)));
    finalPromises = finalPromises.concat(boostsToRevoke.map((boost) => mapBoostToEventPublish(boost, true)));

    logger('Final promises: ', finalPromises);
    // then: fire all of them off, and we are done
    const resultOfFinalCalls = await Promise.all(finalPromises);
    logger('Result of final calls: ', resultOfFinalCalls);

    return resultOfTransfers;
};
