'use strict';

const logger = require('debug')('jupiter:event:dispatch-helper');
const config = require('config');

const util = require('ops-util-common');

module.exports.assembleBoostProcessInvocation = (eventBody) => {
    const eventPayload = {
        eventType: eventBody.eventType,
        timeInMillis: eventBody.timeInMillis,
        accountId: eventBody.context.accountId,
        eventContext: eventBody.context
    };

    const invokeParams = {
        FunctionName: config.get('publishing.processingLambdas.boosts'),
        InvocationType: 'Event',
        Payload: JSON.stringify(eventPayload)
    };

    logger('Lambda invocation for boost processing: ', invokeParams);
    return invokeParams;
};

module.exports.addInvestmentToBSheet = async ({ operation, parameters, persistence, lambda }) => {
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
        const transactionDetails = { accountNumber, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };

        if (operation === 'WITHDRAW') {
            transactionDetails.bankDetails = bankDetails;
        }

        const investmentInvocation = {
            FunctionName: config.get('lambdas.addTxToBalanceSheet'),
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({ operation, transactionDetails })
        };
        
        logger('lambda args:', investmentInvocation);
        const investmentResult = await lambda.invoke(investmentInvocation).promise();
        logger('Investment result from third party:', investmentResult);

        const parsedResult = JSON.parse(investmentResult['Payload']);
        logger('Got response body', parsedResult);
        if (Object.keys(parsedResult).includes('result') && parsedResult.result === 'ERROR') {
            throw new Error(`Error sending investment to third party: ${parsedResult}`);
        }

        const txUpdateResult = await persistence.updateTxTags(transactionId, config.get('defaults.balanceSheet.txFlag'));
        logger('Result of transaction update:', txUpdateResult);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
    }
};
