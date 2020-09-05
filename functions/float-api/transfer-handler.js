'use strict';

const logger = require('debug')('jupiter:float:transfer');
const config = require('config');
const uuid5 = require('uuid/v5');

const rds = require('./persistence/rds');
const constants = require('./constants');

const allocationHelper = require('./allocation-helper');

const Redis = require('ioredis');
const redis = new Redis({
    host: config.get('cache.host'),
    port: config.get('cache.port'),
    retryStrategy: () => `dont retry`,
    keyPrefix: `${config.get('cache.keyPrefixes.float')}::`
});

const txStateCheckInterval = config.get('cache.txStateCheckInterval');

const floatAdjustmentRequest = (instruction) => ({
    amount: instruction.recipients[0].amount,
    unit: instruction.unit,
    currency: instruction.currency,
    clientId: instruction.clientId,
    floatId: instruction.floatId,
    transactionType: instruction.transactionType,
    backingEntityType: instruction.relatedEntity,
    backingEntityIdentifier: instruction.relatedEntityId,
    logType: instruction.logType
});

const allocationFromNonUser = (instruction, sumOfRecipients) => ({
    amount: sumOfRecipients, // NB: assumes this is negative
    allocatedToType: instruction.fromType,
    allocatedToId: instruction.fromId,
    unit: instruction.unit,
    currency: instruction.currency,
    transactionType: instruction.transactionType,
    relatedEntityType: instruction.relatedEntityType,
    relatedEntityId: instruction.identifier
});

const allocationToNonUser = (recipient, instruction) => ({
    amount: recipient.amount,
    allocatedToType: recipient.recipientType,
    allocatedToId: recipient.recipientId,
    unit: instruction.unit,
    currency: instruction.currency,
    transactionType: instruction.transactionType,
    relatedEntityType: instruction.relatedEntityType,
    relatedEntityId: instruction.identifier
});

const allocationForUser = (recipient, instruction) => ({
    amount: recipient.amount,
    unit: instruction.unit,
    currency: instruction.currency,
    accountId: recipient.recipientId,
    allocType: instruction.transactionType,
    allocState: instruction.settlementStatus,
    settlementStatus: instruction.settlementStatus,
    relatedEntityType: instruction.relatedEntityType,
    relatedEntityId: instruction.identifier
});

const allUserAllocation = (instruction) => ({
    clientId: instruction.clientId,
    floatId: instruction.floatId,
    totalAmount: instruction.recipients[0].amount,
    currency: instruction.currency,
    unit: instruction.unit,
    settlementStatus: instruction.settlementStatus,
    allocType: instruction.transactionType,
    backingEntityType: instruction.relatedEntityType,
    backingEntityIdentifer: instruction.identifier,
    allocState: instruction.settlementStatus
});

const isBonusOrCompany = (type) => type === constants.entityTypes.BONUS_POOL || type === constants.entityTypes.COMPANY_SHARE;

const handleActiveTx = async (activeTxId, activeTx = null) => {
    let cacheResult = activeTx;
    if (!cacheResult) {
        cacheResult = await redis.get(activeTxId);
    }

    logger('Got cached transaction state:', cacheResult);

    if (cacheResult === 'PENDING') {
        logger('Transaction is pending. Waiting for completion');
        await new Promise((resolve) => setTimeout(resolve, txStateCheckInterval));
        logger('Checking transaction state');
        return handleActiveTx(activeTxId);
    }

    logger('Transaction complete. Returning result');
    return JSON.parse(cacheResult);
};

const safeCheckCache = async (activeTxId) => {
    // redis connection dropping because of known lambda-elasticache issues are curious spurious fatal errors here
    try {
        const activeTx = await redis.get(activeTxId);
        logger('Got cached transaction state:', activeTx);
        return activeTx;
    } catch (err) {
        logger('Error on transaction handling');
        return null;
    }
};

const safeSetCache = async (activeTxId, value) => {
    try {
        await redis.set(activeTxId, value, 'EX', config.get('cache.ttls.float'));
    } catch (err) {
        logger('Erorr setting cache');
    }
};

/**
 * Method in need of some cleaning up / refactoring to simplify cases, but which is purposefully highly flexible. Cases:
 * Allocations from bonus pool to users; allocation from client pool to users; allocation from company pool to users.
 * Allocations to float itself (i.e., addition to float total balance), allocations from unallocated float balance to
 * company pool / bonus pool (by admin, e.g., after a transfer of company capital into float to fund bonus pool), and finally
 * from float itself (unallocated balance) to all users (i.e., distributing to them)
 * 
 * NOTE: does not allow for, e.g., doing a distribution to users directly from client account -- would get messy, and will be
 * extremely rare. Instead, admin user would do a negative allocation to company, which would free up spare float, and that 
 * would then be distributed to users.
 * 
 * NOTE 2: assumes (given the cases above, that this is 'settled', unless told otherwise)
 * 
 * @param {object} instruction An instruction about the transfer/allocation/reallocation to conduct 
 */
const handleInstruction = async (instruction) => {
    logger('Received transfer instruction, recipients: ', instruction.recipients);

    const activeTxId = uuid5(JSON.stringify(instruction), config.get('cache.namespace'));
    const activeTx = await safeCheckCache(activeTxId);
    if (activeTx) {
        return handleActiveTx(activeTxId, activeTx);
    }

    await safeSetCache(activeTxId, 'PENDING');

    const nonUserAllocRequests = []; // for bonus pool and client share
    const userAllocRequests = [];

    // NB: uses minus so the resulting number is minus (i.e., is allocation _from_ and is deducted in sums)
    const totalFrom = instruction.recipients.reduce((sum, recipient) => sum - recipient.amount, 0);
    
    const isFromUser = instruction.fromType === constants.entityTypes.END_USER_ACCOUNT;
    const isFromCompanyOrBonus = isBonusOrCompany(instruction.fromType);
    const isFromFloatItself = typeof instruction.fromType !== 'string' || instruction.fromType.length === 0;
    
    const isToFloatItself = isFromFloatItself && Array.isArray(instruction.recipients) && instruction.recipients.length === 1 &&   
        instruction.recipients[0].recipientType === 'FLOAT_ITSELF';
    const isToAllUsers = isFromFloatItself && Array.isArray(instruction.recipients) && instruction.recipients.length === 1 && 
        instruction.recipients[0].recipientType === 'ALL_USERS';

    if (isFromUser) {
        userAllocRequests.push(allocationForUser({ recipientId: instruction.fromId, amount: totalFrom}, instruction));        
    } else if (isFromCompanyOrBonus) {
        nonUserAllocRequests.push(allocationFromNonUser(instruction, totalFrom));
    } else if (isFromFloatItself) {
        // todo : validation, eg that if it is to bonus/company, there is enough not-allocated
        logger('Allocation is from float itself, must validate have sufficient in float');
    } else {
        throw new Error('Cannot handle from type passed to allocation');
    }

    instruction.recipients.forEach((recipient) => {
        logger('Processing instruction recipients: ', recipient.recipientType);
        if (recipient.recipientType === 'END_USER_ACCOUNT') {
            userAllocRequests.push(allocationForUser(recipient, instruction, false));
        } else if (isBonusOrCompany(recipient.recipientType)) {
            nonUserAllocRequests.push(allocationToNonUser(recipient, instruction));
        }
    });

    let floatTxIds = [];
    let accountTxIds = [];

    if (isToFloatItself) {
        logger('Adjusting float itself, with request: ', floatAdjustmentRequest(instruction));
        const floatAdjustmentResult = await rds.addOrSubtractFloat(floatAdjustmentRequest(instruction));
        logger('Result of float adjustment: ', floatAdjustmentResult);
        floatTxIds = [floatAdjustmentResult.transactionId];
    }

    if (isToAllUsers) {
        const allocInstruction = allUserAllocation(instruction);
        logger('Sending to division: ', allocInstruction);
        const userDistResult = await allocationHelper.allocate(allocInstruction);
        logger('Result of allocation: ', userDistResult);
        floatTxIds = userDistResult.allocationRecords.floatTxIds;
        accountTxIds = userDistResult.allocationRecords.accountTxIds;
    }

    if (nonUserAllocRequests.length > 0) {
        logger('Sending non-user allocations to persistence: ', nonUserAllocRequests);
        const nonUserAllocResult = await rds.allocateFloat(instruction.clientId, instruction.floatId, nonUserAllocRequests);
        logger('Result of float allocations: ', nonUserAllocResult);
        floatTxIds = floatTxIds.concat(Object.values(nonUserAllocResult.map((row) => row['id'])));
    }

    if (userAllocRequests.length > 0) {
        logger('Sending user allocations to persistence: ', userAllocRequests);
        const userAllocResult = await rds.allocateToUsers(instruction.clientId, instruction.floatId, userAllocRequests);
        logger('Result of user allocations: ', userAllocResult);
        floatTxIds = floatTxIds.concat(userAllocResult.floatTxIds);
        accountTxIds = accountTxIds.concat(userAllocResult.accountTxIds);
    }

    const finalResult = {
        id: instruction.identifier, 
        details: {
            result: 'SUCCESS',
            floatTxIds,
            accountTxIds
        }
    };

    await safeSetCache(activeTxId, JSON.stringify(finalResult));
    return finalResult;
};

/**
 * This function handles float transfer instructions. Event properties are described below.
 * @param {array} instructions An array containing transfer instruction objects.
 */
module.exports.floatTransfer = async (event) => {
    logger('Received transfer event: ', event);

    // todo : huge amounts of validation
    const transferInstructions = event.instructions;
    const promiseList = transferInstructions.map((instruction) => handleInstruction(instruction));

    const resultOfTransfers = await Promise.all(promiseList);
    
    const assembledResult = resultOfTransfers.reduce((obj, result) => ({ ...obj, [result.id]: result.details }), {});
    // logger('Here is what we have: ', assembledResult);

    return {
        statusCode: 200,
        body: JSON.stringify(assembledResult)
    };
};
