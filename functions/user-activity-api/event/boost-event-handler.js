'use strict';

module.exports.handleBoostRedeemedEvent = async (eventBody) => {
    logger('Handling boost redeemed event: ', eventBody);
    const { accountId, boostAmount } = eventBody.context;

    const bSheetReference = await persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'));
    const [amount, unit, currency] = boostAmount.split('::');
    const wholeCurrencyAmount = parseInt(amount, 10) / UNIT_DIVISORS_TO_WHOLE[unit];

    const transactionDetails = { accountNumber: bSheetReference, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };
    const lambdaPayload = { operation: 'BOOST', transactionDetails };

    const investmentInvocation = invokeLambda(config.get('lambdas.addTxToBalanceSheet'), lambdaPayload);
    logger('Payload for balance sheet lambda: ', investmentInvocation);

    const bSheetResult = await lambda.invoke(investmentInvocation).promise();
    logger('Balance sheet result: ', bSheetResult);
};
