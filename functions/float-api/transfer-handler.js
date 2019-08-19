'use strict';

const logger = require('debug')('jupiter:float:transfer');

const rds = require('./persistence/rds');
const constants = require('./constants');

const allocationFromNonUser = (instruction, sumOfRecipients) => ({
    amount: sumOfRecipients, // NB: assumes this is negative
    allocatedToType: instruction.fromType,
    allocatedToId: instruction.fromId,
    unit: instruction.unit,
    currency: instruction.currency,
    relatedEntityType: instruction.relatedEntityType,
    relatedEntityId: instruction.identifier
});

const allocationToNonUser = (recipient, instruction) => ({
    amount: recipient.amount,
    allocatedToType: recipient.recipientType,
    allocatedToId: recipient.recipientId,
    unit: instruction.unit,
    currency: instruction.currency,
    relatedEntityType: instruction.relatedEntityType,
    relatedEntityId: instruction.identifier
});

const allocationForUser = (recipient, instruction) => ({
    amount: recipient.amount,
    unit: instruction.unit,
    currency: instruction.currency,
    accountId: recipient.recipientId,
    allocType: instruction.relatedEntityType
});

const handleInstruction = async (instruction) => {
    const nonUserAllocRequests = []; // for bonus pool and client share
    const userAllocRequests = [];

    // NB: uses minus so the resulting number is minus (i.e., is allocation _from_ and is deducted in sums)
    const totalFrom = instruction.recipients.reduce((sum, recipient) => sum - recipient.amount, 0);
    if (instruction.fromType === constants.entityTypes.END_USER_ACCOUNT) {
        userAllocRequests.push(allocationForUser({ recipientId: instruction.fromId, amount: totalFrom}, instruction));        
    } else if (instruction.fromType === constants.entityTypes.BONUS_POOL || fromType === constants.entityTypes.COMPANY_SHARE) {
        nonUserAllocRequests.push(allocationFromNonUser(instruction, totalFrom));
    } else {
        throw new Error('Cannot handle from type passed to transfer');
    }

    instruction.recipients.forEach((recipient) => {
        if (recipient.recipientType === 'END_USER_ACCOUNT') {
            userAllocRequests.push(allocationForUser(recipient, instruction, false));
        } else {
            nonUserAllocRequests.push(allocationToNonUser(recipient, instruction));
        }
    });

    let floatTxIds = [];
    let accountTxIds = [];

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
        floatTxIds = floatTxIds.concat(userAllocResult.floatTxIds.map((row) => row['transaction_id']));
        accountTxIds = accountTxIds.concat(userAllocResult.accountTxIds.map((row) => row['transaction_id']));
    }

    return {
        id: instruction.identifier, 
        details: {
            result: 'SUCCESS',
            floatTxIds,
            accountTxIds
        }
    };
};

module.exports.floatTransfer = async (event) => {
    logger('Received transfer event: ', event);

    // todo : huge amounts of validation
    const transferInstructions = event.instructions;
    const promiseList = transferInstructions.map((instruction) => handleInstruction(instruction));

    const resultOfTransfers = await Promise.all(promiseList);
    
    const assembledResult = resultOfTransfers.reduce((obj, result) => ({ ...obj, [result.id]: result.details }), {});
    logger('Here is what we have: ', assembledResult);

    return {
        statusCode: 200,
        body: JSON.stringify(assembledResult)
    };
};