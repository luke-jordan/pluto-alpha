'use strict';

const logger = require('debug')('jupiter:withdraw:main');
const config = require('config');
const moment = require('moment');

const status = require('statuses');
const publisher = require('publish-common');
const persistence = require('./persistence/rds');

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const handleError = (err) => { 
    logger('FATAL_ERROR: ', err);
    return { statusCode: 500, body: JSON.stringify(err.message) };
};

// note: we are going to need a cache here, since we do not want to persist the bank account details

/**
 * Initiates a withdrawal by setting the bank account for it, which gets verified, and then we go from there
 */
module.exports.setWithdrawalBankAccount = async (event) => {
    try {
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
        
        await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_INITIATED');
        const withdrawalInformation = JSON.parse(event.body);

        // first, verify bank account ownership

        // then, create a pending withdrawal transaction

        // then, get the balance available
        // todo : get the currency from user (?)
        const availableBalance = await persistence.sumAccountBalance(withdrawalInformation.accountId, 'ZAR');

        const responseObject = {
            transactionId: uuid(),
            availableBalance,
            cardTitle: 'Did you know?',
            cardBody: 'Over the next two years you could accumulate xx% interest. Why not delay your withdraw to keep these savings and earn more for your future!'
        }

        return { statusCode: 200, body: JSON.stringify(responseObject) };
    } catch (err) {
        return handleError(err);
    }
};

/**
 * Proceeds to next item, the withdrawal amount
 */
module.exports.setWithdrawalAmount = async (event) =>{
    try {
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
        
        const withdrawalInformation = JSON.parse(event.body);
        if (!withdrawalInformation.transactionId) {
            return invalidRequestResponse('Requires a transaction Id');
        } else if (!withdrawalInformation.amount) {
            return invalidRequestResponse('Error, must send amount to withdraw');
        }

        const transactionDetails = await persistence.findMatchingTransaction({ transactionId })
        const availableBalance = await persistence.sumAccountBalance(transactionDetails.accountId);

        if (withdrawalInformation.amount > availableBalance) {
            return invalidRequestResponse('Error, trying to withdraw more than available');
        }

        // (1) update the transaction, and (2) decide if a boost should be offered
        const delayTime = moment().add(7, 'days');
        const delayOffer = { boostAmount: '30000::HUNDREDTH_CENT::ZAR', requiredDelay: delayTime };
        // then, assemble and send back

        return {
            statusCode: 200, body: JSON.stringify({ delayOffer })
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

        if (withdrawalInformation.userDecision === 'CANCEL') {
            // process the boost, and tell the user
            await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_CANCELLED');
            return { statusCode: 200 };
        }

        // user wants to go through with it, so (1) send an email about it, (2) update the transaction, (3) update 3rd-party

        // then, settle the balance
        const response = { balance: 'TBC' };
        await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_CONFIRMED');

        return { statusCode: 200, body: JSON.stringify(response) };
    } catch (err) {
        return handleError(err);
    }
};