'use strict';

const logger = require('debug')('jupiter:boost:redemption');
const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const DEFAULT_UNIT = 'HUNDREDTH_CENT';

const calculatePooledBoostAmount = (boost, userCount) => {
    if (userCount <= 1) {
        return { boostAmount: 0, amountFromBonus: 0 };
    }

    let amountFromBonus = 0;
    const { poolContributionPerUser, percentPoolAsReward, clientFloatContribution } = boost.rewardParameters;
    
    const contribAmount = opsUtil.convertToUnit(poolContributionPerUser.amount, poolContributionPerUser.unit, DEFAULT_UNIT);
    const totalPoolFromUsers = userCount * contribAmount;

    let calculatedBoostAmount = totalPoolFromUsers * percentPoolAsReward;
    
    const floatContributionAvailable = clientFloatContribution && userCount >= clientFloatContribution.requiredFriends;
    if (floatContributionAvailable && clientFloatContribution.type === 'PERCENT_OF_POOL') {
        amountFromBonus = totalPoolFromUsers * clientFloatContribution.value;
    }

    if (floatContributionAvailable && clientFloatContribution.type === 'ABS_AMOUNT') {
        const { additionalBonusToPool } = clientFloatContribution;
        amountFromBonus = opsUtil.convertToUnit(additionalBonusToPool.amount, additionalBonusToPool.unit, DEFAULT_UNIT);    
    }

    calculatedBoostAmount += amountFromBonus;
    const boostAmount = opsUtil.convertToUnit(calculatedBoostAmount, DEFAULT_UNIT, boost.boostUnit);

    return { boostAmount, amountFromBonus };
};

const generateMultiplier = (distribution) => {
    if (distribution === 'UNIFORM') {
        return (Math.random()).toFixed(2);
    }
};

const calculateRandomBoostAmount = (boost, isConsolation = false) => {
    const { distribution, realizedRewardModuloZeroTarget, minRewardAmountPerUser } = isConsolation
        ? boost.rewardParameters.consolationPrize : boost.rewardParameters;

    const boostAmount = opsUtil.convertToUnit(boost.boostAmount, boost.boostUnit, DEFAULT_UNIT);
    const minBoostAmount = minRewardAmountPerUser 
        ? opsUtil.convertToUnit(minRewardAmountPerUser.amount, minRewardAmountPerUser.unit, DEFAULT_UNIT) : 0;
    
    const multiplier = generateMultiplier(distribution);
    logger('Random award, generated multiplier: ', multiplier);

    // eslint-disable-next-line no-mixed-operators
    let calculatedBoostAmount = Math.round(multiplier * (boostAmount - minBoostAmount) + minBoostAmount); // todo : use decimal light
    logger('Initial calculated boost amount: ', calculatedBoostAmount);
    
    const amountToSnapTo = opsUtil.convertToUnit(realizedRewardModuloZeroTarget || 1, boost.boostUnit, DEFAULT_UNIT);
    logger('Will need to snap to modulo 0 of : ', amountToSnapTo, ' current gap: ', calculatedBoostAmount % amountToSnapTo);
    if (calculatedBoostAmount % amountToSnapTo > 0) {
        const amountAboveSnap = calculatedBoostAmount % amountToSnapTo;
        calculatedBoostAmount += (amountToSnapTo - amountAboveSnap);
    }

    // Try again if the calculatedBoostAmount is rounded to a value greater than the boost amount or less than min amount
    if (calculatedBoostAmount > boostAmount) {
        return calculateRandomBoostAmount(boost);
    }

    logger('Random boost award, calculated amount:', calculatedBoostAmount);
    return opsUtil.convertToUnit(calculatedBoostAmount, DEFAULT_UNIT, boost.boostUnit);
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
        logger('TRANSFER_ERROR: see above for lambda result, triggered by instruction: ', transferInstructions);
        throw new Error('Error completing float transfers');
    }

    const transferResults = JSON.parse(resultOfTransfer.body);
    
    // what a code smell but things are just too rough right now, at some point there will be sleep and this will have to get cleaned up
    const extractRefAmounts = (boostId) => transferInstructions.find((instruction) => instruction.identifier === boostId);
    const mergeResultWithRef = (boostId) => ({ ...transferResults[boostId], ...extractRefAmounts(boostId).referenceAmounts });
    const resultsWithReferenceAmounts = Object.keys(transferResults).reduce((obj, boostId) => 
        ({ ...obj, [boostId]: mergeResultWithRef(boostId) }), {});

    return resultsWithReferenceAmounts;
};

const handleTransferToBonusPool = async (affectedAccountDict, boost, pooledContributionMap, event) => {
    logger('Pool contribution map : ', pooledContributionMap);
    
    const accountIds = pooledContributionMap[boost.boostId];
    if (!accountIds || accountIds.length === 0) {
        throw new Error('Error! No account ids for reward pool'); 
    }

    if (accountIds.length === 1) {
        logger('Only one contributor, so no prize, exit');
        return { result: 'ONLY_ONE_SAVER' }; 
    }

    const { rewardParameters } = boost;
    logger('Reward parameters : ', rewardParameters);

    const { poolContributionPerUser } = rewardParameters;
    
    const contribInDefault = opsUtil.convertToUnit(poolContributionPerUser.amount * rewardParameters.percentPoolAsReward, poolContributionPerUser.unit, DEFAULT_UNIT);
    const amountToContrib = Math.max(0, Math.round(contribInDefault));

    const poolContrib = {
        amount: amountToContrib,
        unit: DEFAULT_UNIT,
        currency: poolContributionPerUser.currency
    };

    logger('Defined pool contribution: ', poolContrib);
    
    const recipients = accountIds.map((recipientId) => ({
        recipientId, amount: -poolContrib.amount, recipientType: 'END_USER_ACCOUNT'
    }));

    const transferInstruction = {
        floatId: boost.fromFloatId,
        clientId: boost.forClientId,
        fromId: boost.fromBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: poolContrib.currency,
        unit: poolContrib.unit,
        identifier: boost.boostId,
        relatedEntityType: 'BOOST_POOL_FUNDING',
        allocType: 'BOOST_POOL_FUNDING', // for float allocation
        allocState: 'SETTLED',
        transactionType: 'BOOST_POOL_FUNDING', // for matching account records
        settlementStatus: 'SETTLED',
        recipients
    };

    logger('Invoking bonus pool float transfer lambda with payload:', transferInstruction);
    const resultOfTransfer = await triggerFloatTransfers([transferInstruction]);
    logger('Result of transfer to bonus pool:', resultOfTransfer);

    const eventLogContext = {
        boostId: boost.boostId,
        boostType: boost.boostType,
        boostCategory: boost.boostCategory,
        rewardParameters: boost.rewardParameters,
        poolContribution: poolContrib,
        transferResults: resultOfTransfer,
        triggeringEventContext: event.eventContext,
        logSource: 'boost_redemption_handler'
    };

    logger('Extracting userIds from affected account dict: ', affectedAccountDict);
    const accountIdsAffected = Object.keys(affectedAccountDict[boost.boostId]).filter((accountId) => accountIds.includes(accountId));
    logger('Provides accountIds with user Ids present: ', accountIdsAffected);
    const userIds = accountIdsAffected.map((accountId) => affectedAccountDict[boost.boostId][accountId].userId);
    logger('And user IDs: ', userIds);

    const resultOfPublish = await publisher.publishMultiUserEvent(userIds, 'BOOST_POOL_FUNDED', { context: eventLogContext });

    logger('Result of publish:', resultOfPublish);

    return { resultOfTransfer, resultOfPublish };
};

// note: this is only called for redeemed boosts, by definition. also means it is 'settled' by definition. it redeemes, no matter prior status
// further note: if this is a revocation, the negative will work as required on sums, but test the hell out of this (and viz transfer-handler)
const generateFloatTransferInstructions = async (affectedAccountDict, boost, revoke, pooledContributionMap = {}, event = {}) => {
    // if pooled reward handle initial transfers from accounts to bonus pool
    if (boost.rewardParameters && boost.rewardParameters.rewardType === 'POOLED') {
        const resultOfInitialTransfer = await handleTransferToBonusPool(affectedAccountDict, boost, pooledContributionMap, event);
        logger('Result of initial transfer to bonus pool:', resultOfInitialTransfer);
    }

    const accountUserMap = affectedAccountDict[boost.boostId];
    const accountIds = Object.keys(accountUserMap);

    const recipientAccounts = accountIds.filter((accountId) => accountUserMap[accountId].status === 'REDEEMED');

    const referenceAmounts = exports.calculateBoostAmount(boost, pooledContributionMap);
    const { boostAmount } = referenceAmounts;
    logger('Calculated amounts for boost: ', boostAmount);
    
    if (boostAmount === 0) {
        logger('No boost amount, so exit');
        return null;
    }

    const amount = revoke ? -boostAmount : boostAmount;
    const transactionType = revoke ? 'BOOST_REVERSAL' : 'BOOST_REDEMPTION';
    
    const recipients = recipientAccounts.map((recipientId) => ({ 
        recipientId, amount, recipientType: 'END_USER_ACCOUNT'
    }));

    return {
        floatId: boost.fromFloatId,
        clientId: boost.forClientId,
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
        referenceAmounts,
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
    if (!Array.isArray(boostMessageInstructions) || boostMessageInstructions.length === 0) {
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

const createPublishEventPromises = (parameters) => {
    const { boost, affectedAccountsUserDict: affectedAccountMap, transferResults, transferInstructions, isRevocation, event } = parameters;
    
    const boostUpdateTimeMillis = parameters.boostUpdateTime ? parameters.boostUpdateTime.valueOf() : moment().valueOf();
    const eventType = parameters.specifiedEventType || (isRevocation ? 'BOOST_REVOKED' : 'BOOST_REDEEMED');
    
    logger('Publishing redemption promises, with transfer results: ', transferResults);
    
    const publishPromises = Object.keys(affectedAccountMap).map((accountId) => {
        const { referenceAmounts } = transferInstructions;
        const boostAmount = isRevocation ? -referenceAmounts.boostAmount : referenceAmounts.boostAmount;
        
        const context = {
            accountId,
            boostId: boost.boostId,
            boostType: boost.boostType,
            boostCategory: boost.boostCategory,
            boostUpdateTimeMillis,
            boostAmount: `${boostAmount}::${boost.boostUnit}::${boost.boostCurrency}`,
            amountFromBonus: `${referenceAmounts.amountFromBonus}::${boost.boostUnit}::${boost.boostCurrency}`,
            transferResults,
            triggeringEventContext: event.eventContext
        };
        const options = { context };
        if (event.accountId && affectedAccountMap[event.accountId]) {
            options.initiator = affectedAccountMap[event.accountId]['userId'];
        }
        logger(`Publishing: ${affectedAccountMap[accountId]['userId']}::${eventType}`);
        return publisher.publishUserEvent(affectedAccountMap[accountId]['userId'], eventType, options);
    });

    // logger('Publish result: ', publishPromises);
    return publishPromises;
};

const calculateConsolationAmount = (boost) => {
    const { type, consolationAmount } = boost.rewardParameters.consolationPrize;

    if (type === 'RANDOM') {
        const boostAmount = calculateRandomBoostAmount(boost, true);
        return { boostAmount, amountFromBonus: boostAmount };
    }

    const boostAmount = opsUtil.convertToUnit(consolationAmount.amount, consolationAmount.unit, boost.boostUnit);
    return { boostAmount, amountFromBonus: boostAmount };
};

const fetchConsolationDetails = (boost, affectedAccountDict) => {
    logger('Calculating consolation amount and recipeints');
    const { consolationAwards } = boost.rewardParameters.consolationPrize;

    const accountUserMap = affectedAccountDict[boost.boostId];
    const accountIds = Object.keys(accountUserMap);
    const recipientAccounts = accountIds.filter((accountId) => accountUserMap[accountId].status !== 'REDEEMED');
    logger('Got possible recipients: ', recipientAccounts);

    const consolationDetails = {
        referenceAmounts: calculateConsolationAmount(boost)
    };
    
    if (consolationAwards.basis === 'ALL') {
        consolationDetails.recipientAccounts = recipientAccounts;
    }

    if (consolationAwards.basis === 'ABSOLUTE') {
        consolationDetails.recipientAccounts = recipientAccounts.slice(0, consolationAwards.recipients);
    }

    if (consolationAwards.basis === 'PROPORTION') {
        const numberOfRecipients = Math.round(recipientAccounts.length * consolationAwards.recipients);
        consolationDetails.recipientAccounts = recipientAccounts.slice(0, numberOfRecipients);
    }

    logger('Got consolation details: ', consolationDetails);
    return consolationDetails;
};

const generateConsolationInstructions = async (boost, affectedAccountDict) => {
    const consolationDetails = fetchConsolationDetails(boost, affectedAccountDict);

    const { recipientAccounts, referenceAmounts } = consolationDetails;

    const { boostAmount } = referenceAmounts;

    const recipients = recipientAccounts.map((recipientId) => ({ 
        recipientId, amount: boostAmount, recipientType: 'END_USER_ACCOUNT'
    }));

    return {
        floatId: boost.fromFloatId,
        clientId: boost.forClientId,
        fromId: boost.fromBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: boost.boostCurrency,
        unit: boost.boostUnit,
        identifier: boost.boostId,
        relatedEntityType: 'BOOST_REDEMPTION',
        allocType: 'BOOST_REDEMPTION',
        allocState: 'SETTLED',
        transactionType: 'BOOST_REDEMPTION',
        settlementStatus: 'SETTLED',
        referenceAmounts,
        recipients
    };
};

/** Used also in expiry handler to set the boost amount once this is done, so exporting */
module.exports.calculateBoostAmount = (boost, pooledContributionMap) => {
    const rewardType = boost.rewardParameters ? boost.rewardParameters.rewardType : 'STANDARD';

    if (rewardType === 'POOLED') {
        const accountIds = pooledContributionMap[boost.boostId];
        const userCount = accountIds.length;
        return calculatePooledBoostAmount(boost, userCount);
    }

    if (rewardType === 'RANDOM') {
        const boostAmount = calculateRandomBoostAmount(boost);
        return { boostAmount, amountFromBonus: boostAmount };
    }

    return { boostAmount: boost.boostAmount, amountFromBonus: boost.boostAmount };
};

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
    const redeemInstructions = (await Promise.all(boostsToRedeem.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost, false, pooledContributionMap, event)))).
            filter((instruction) => instruction !== null);

    logger('***** Transfer instructions: ', redeemInstructions);

    const revokeInstructions = (await Promise.all(boostsToRevoke.map((boost) => generateFloatTransferInstructions(affectedAccountsDict, boost, true)))).
            filter((instruction) => instruction !== null);

    logger('***** Revoke instructions: ', revokeInstructions);

    const transferInstructions = redeemInstructions.concat(revokeInstructions);
    const resultOfTransfers = await (transferInstructions.length === 0 ? {} : triggerFloatTransfers(transferInstructions));
    logger('Result of transfers: ', resultOfTransfers);

    const boostConsolations = boostsToRedeem.filter((boost) => boost.rewardParameters && boost.rewardParameters.consolationPrize);

    if (boostConsolations.length > 0) {
        const consolationInstructions = await Promise.all(boostConsolations.map((boost) => generateConsolationInstructions(boost, affectedAccountsDict)));
        logger('***** Consolation instructions: ', consolationInstructions);
        const resultOfConsolations = await triggerFloatTransfers(consolationInstructions);
        logger('Result of consolations: ', resultOfConsolations);
    }

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
    
    if (transferInstructions.length > 0) {
        const mapBoostToEventPublish = (boost, isRevocation) => createPublishEventPromises({ 
            boost,
            affectedAccountsUserDict: affectedAccountsDict[boost.boostId],
            transferResults: resultOfTransfers[boost.boostId],
            transferInstructions: transferInstructions.find((instruction) => instruction.identifier === boost.boostId),
            event,
            isRevocation
        });
    
        finalPromises = finalPromises.concat(boostsToRedeem.map((boost) => mapBoostToEventPublish(boost, false)));
        finalPromises = finalPromises.concat(boostsToRevoke.map((boost) => mapBoostToEventPublish(boost, true)));    
    }

    logger('Final promises, of length: ', finalPromises.length);
    // then: fire all of them off, and we are done
    const resultOfFinalCalls = await Promise.all(finalPromises);
    logger('Result of final calls: ', resultOfFinalCalls);

    return resultOfTransfers;
};
