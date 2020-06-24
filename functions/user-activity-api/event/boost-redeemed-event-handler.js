'use strict';

const logger = require('debug')('jupiter:event:boost');
const config = require('config');

const util = require('ops-util-common');

module.exports.handleBoostRedeemedEvent = async ({ eventBody, persistence, lambda }) => {
    logger('Handling boost redeemed event: ', eventBody);
    const { accountId, boostAmount } = eventBody.context;

    const bSheetReference = await persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'));
    
    const [amount, unit, currency] = boostAmount.split('::');
    const wholeCurrencyAmount = util.convertToUnit(amount, unit, 'WHOLE_CURRENCY');

    const transactionDetails = { accountNumber: bSheetReference, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };
    const lambdaPayload = { operation: 'BOOST', transactionDetails };

    const investmentInvocation = {
        FunctionName: config.get('lambdas.addTxToBalanceSheet'),
        InvocationType: 'Event',
        Payload: JSON.stringify(lambdaPayload)
    };
    
    logger('Payload for balance sheet lambda: ', investmentInvocation);
    const bSheetResult = await lambda.invoke(investmentInvocation).promise();
    logger('Balance sheet result: ', bSheetResult);
};
