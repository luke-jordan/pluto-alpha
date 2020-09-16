'use strict';

const logger = require('debug')('jupiter:event:dispatch-helper');
const config = require('config');

const util = require('ops-util-common');

module.exports.sendEventToBoostProcessing = async (eventBody, publisher) => {
    const eventPayload = {
        userId: eventBody.userId,
        eventType: eventBody.eventType,
        timeInMillis: eventBody.timestamp,
        eventContext: eventBody.context
    };

    if (eventBody.context && eventBody.context.accountId) {
        eventPayload.accountId = eventBody.context.accountId;
    }

    const queueResult = await publisher.sendToQueue(config.get('queues.boostProcess'), [eventPayload], true);
    logger('Result of queueing boost process: ', queueResult);
    return { result: 'QUEUED' };
};

// note: make idempotent
module.exports.addInvestmentToBSheet = async ({ operation, parameters, persistence, publisher }) => {
    // still some stuff to work out here, e.g., in syncing up the account number, so rather catch & log, and let other actions pass
    try {
        const { accountId, amount, unit, currency, transactionId, bankDetails } = parameters;

        const accountNumber = await persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'));
        logger('Got third party account number:', accountNumber);

        if (!accountNumber) {
            // we don't actually throw this, but do log it, because admin needs to know
            logger('FATAL_ERROR: No FinWorks account number for user!');
            return;
        }
        
        const wholeCurrencyAmount = util.convertToUnit(parseInt(amount, 10), unit, 'WHOLE_CURRENCY');
        const transactionDetails = { transactionId, accountNumber, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };

        if (operation === 'WITHDRAW') {
            transactionDetails.bankDetails = bankDetails;
        }

        const investmentInvocation = { operation, transactionDetails };
        logger('Queue payload:', investmentInvocation);
        const investmentResult = await publisher.sendToQueue(config.get('queues.balanceSheetUpdate'), [investmentInvocation], true);
        logger('Queue dispatch result:', investmentResult);

        // as in boost handler, if there is a failure, balance sheet system must take care of retrying, raising alert etc,
        // this handler should not be trying to do so
        const txUpdateResult = await persistence.updateTxTags(transactionId, config.get('defaults.balanceSheet.txTagPrefix'));
        logger('Result of transaction update:', txUpdateResult);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
    }
};
