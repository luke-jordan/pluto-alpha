'use strict';

const logger = require('debug')('jupiter:withdraw:main');
const config = require('config');
const moment = require('moment');

const status = require('statuses');
const publisher = require('publish-common');
const persistence = require('./persistence/rds');

const Redis = require('ioredis');
const redis = new Redis({ port: config.get('cache.port'), host: config.get('cache.host') });

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const handleError = (err) => { 
    logger('FATAL_ERROR: ', err);
    return { statusCode: 500, body: JSON.stringify(err.message) };
};

// note: third use of this. probably want a common location before long. first key is "from", second key is "to"
const UNIT_MULTIPLIERS = {
    'WHOLE_CURRENCY': {
        'HUNDREDTH_CENT': 10000,
        'WHOLE_CENT': 100,
        'WHOLE_CURRENCY': 1
    },
    'WHOLE_CENT': {
        'WHOLE_CURRENCY': 0.01,
        'WHOLE_CENT': 1,
        'HUNDREDTH_CENT': 100
    },
    'HUNDREDTH_CENT': {
        'WHOLE_CURRENCY': 0.0001,
        'WHOLE_CENT': 0.01,
        'HUNDREDTH_CENT': 1
    }
};

// note: for a lot of compliance reasons, we are not persisting the bank account, so rather cache it
const cacheBankAccountDetails = async (systemWideUserId, bankAccountDetails) => {
    const key = `${systemWideUserId}::BANK_DETAILS`;
    await redis.set(key, JSON.stringify(bankAccountDetails), 'EX', 900); // i.e., for fifteen minutes
    logger('Done! Can move along');
};

/**
 * Initiates a withdrawal by setting the bank account for it, which gets verified, and then we go from there
 */
module.exports.setWithdrawalBankAccount = async (event) => {
    try {
        logger('Initiating withdrawal ...');
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
        
        // await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_INITIATED');
        const withdrawalInformation = JSON.parse(event.body);
        const accountId = withdrawalInformation.accountId;

        // first, verify bank account ownership, to be completed
        const isBankAccountValid = true;
        if (!isBankAccountValid) {
            return invalidRequestResponse({ result: 'BANK_ACCOUNT_INVALID' });
        }

        // then, make sure the user has saved in the past
        const priorUserSaves = await persistence.countSettledSaves(accountId);
        if (priorUserSaves === 0) {            
            return invalidRequestResponse({ result: 'USER_HAS_NOT_SAVED' });
        }

        // then, get the balance available, and also store the account details
        const currency = await persistence.findMostCommonCurrency(accountId);
        logger('Most common currency: ', currency);
        const availableBalance = await persistence.sumAccountBalance(withdrawalInformation.accountId, currency);

        await cacheBankAccountDetails(authParams.systemWideUserId, withdrawalInformation.bankDetails);

        const responseObject = {
            availableBalance,
            cardTitle: 'Did you know?',
            cardBody: 'Over the next two years you could accumulate xx% interest. Why not delay your withdraw to keep these savings and earn more for your future!'
        }

        return { statusCode: 200, body: JSON.stringify(responseObject) };
    } catch (err) {
        return handleError(err);
    }
};

// note: _should_ come from client as positive, but just to make sure
const checkSufficientBalance = (withdrawalInformation, balanceInformation) => {
    const multiplier = UNIT_MULTIPLIERS[balanceInformation.unit][withdrawalInformation.unit];
    const absValueWithdrawal = Math.abs(withdrawalInformation.amount); 
    return absValueWithdrawal <= (balanceInformation.amount * multiplier);
};

/**
 * Proceeds to next item, the withdrawal amount, where we create the pending transaction, and decide whether to make an offer
 */
module.exports.setWithdrawalAmount = async (event) =>{
    try {
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
        
        const withdrawalInformation = JSON.parse(event.body);
        
        if (!withdrawalInformation.amount || !withdrawalInformation.unit || !withdrawalInformation.currency) {
            return invalidRequestResponse('Error, must send amount to withdraw, along with unit and currency');
        }

        // then, check if amount is above balance
        const accountId = withdrawalInformation.accountId;
        const availableBalance = await persistence.sumAccountBalance(accountId, withdrawalInformation.currency);

        if (!checkSufficientBalance(withdrawalInformation, availableBalance)) {
            return invalidRequestResponse('Error, trying to withdraw more than available');
        }
        
        // make sure the amount is negative (as that makes the sums etc work)
        withdrawalInformation.amount = -Math.abs(withdrawalInformation.amount);
        withdrawalInformation.transactionType = 'WITHDRAWAL';
        withdrawalInformation.settlementStatus = 'PENDING';
        withdrawalInformation.initiationTime = moment();

        if (!withdrawalInformation.floatId || !withdrawalInformation.clientId) {
            const floatAndClient = await persistence.findClientAndFloatForAccount(accountId);
            withdrawalInformation.floatId = withdrawalInformation.floatId || floatAndClient.floatId;
            withdrawalInformation.clientId = withdrawalInformation.clientId || floatAndClient.clientId;
        }

        // (1) create the pending transaction, and (2) decide if a boost should be offered
        const { transactionDetails } = await persistence.addTransactionToAccount(withdrawalInformation);
        logger('Transaction details from persistence: ', transactionDetails);
        const transactionId = transactionDetails[0]['accountTransactionId'];

        // for now, we are just stubbing this
        const delayTime = moment().add(7, 'days');
        const delayOffer = { boostAmount: '30000::HUNDREDTH_CENT::ZAR', requiredDelay: delayTime };
        
        // then, assemble and send back
        return {
            statusCode: 200, body: JSON.stringify({ transactionId, delayOffer })
        };
    } catch (err) {
        return handleError(err);
    }
};

module.exports.confirmWithdrawal = async (event) => {
    try {
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }

        const withdrawalInformation = JSON.parse(event.body);
        if (!withdrawalInformation.transactionId) {
            return invalidRequestResponse('Requires a transaction Id');
        } else if (!withdrawalInformation.userDecision || ['CANCEL', 'WITHDRAW'].indexOf(withdrawalInformation.userDecision) === -1) {
            return invalidRequestResponse('Requires a valid user decision');
        }

        const transactionId = withdrawalInformation.transactionId;
        if (withdrawalInformation.userDecision === 'CANCEL') {
            // process the boost, and tell the user, then update the transaction
            await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_CANCELLED');
            return { statusCode: 200 };
        }

        // user wants to go through with it, so (1) send an email about it, (2) update the transaction, (3) update 3rd-party
        const resultOfUpdate = await persistence.updateTxToSettled({ transactionId, settlementTime: moment() });

        // then, return the balance
        const response = { balance: resultOfUpdate.newBalance };
        
        // last, publish this (i.e., so instruction goes out)
        const txProperties = await persistence.fetchTransaction(transactionId);
        const context = {
            transactionId,
            accountId: txProperties.accountId,
            timeInMillis: txProperties.settlementTime,
            withdrawalAmount: `${txDetails.amount}::${txDetails.unit}::${txDetails.currency}`
        };
        await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_CONFIRMED', { context });

        return { statusCode: 200, body: JSON.stringify(response) };
    } catch (err) {
        return handleError(err);
    }
};