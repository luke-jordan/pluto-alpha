'use strict';

const logger = require('debug')('jupiter:event:boost');
const config = require('config');

const util = require('ops-util-common');

// todo : make this idempotent by tagging the transaction
module.exports.handleBoostRedeemedEvent = async ({ eventBody, persistence, lambda }) => {
    logger('Handling boost redeemed event: ', JSON.stringify(eventBody));
    const { accountId, boostAmount, transferResults } = eventBody.context;
    if (!transferResults || !Array.isArray(transferResults.accountTxIds) || transferResults.accountTxIds.length === 0) {
        throw Error('Error! Malformed event context, no transaction ID');
    }

    const [transactionId] = transferResults.accountTxIds;

    const [txDetails, bSheetReference] = await Promise.all([
        persistence.fetchTransaction(transactionId),
        persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'))
    ]);

    logger('Retrieved transaction matching to this boost redemption: ', txDetails);

    if (txDetails.accountId !== accountId) {
        throw Error('Error! Transaction and account do not match');
    }

    const bsheetTxTag = config.get('defaults.balanceSheet.txTagPrefix');
    const bsheetTag = txDetails.tags.find((tag) => tag.startsWith(bsheetTxTag));

    const [unparsedAmount, unit, currency] = boostAmount.split('::');
    const amount = parseInt(unparsedAmount, 10);

    // we want to know quickly if these mismatches occur, so check for them even if don't need to send to bsheet
    if (txDetails.currency !== currency || util.convertToUnit(txDetails.amount, txDetails.unit, unit) !== amount) {
        throw Error('Error! Mismatch between transaction as persisted and amount on boost redemption');
    }

    if (bsheetTag) {
        // eslint-disable-next-line no-unused-vars
        const [_, taggedAmount, taggedUnit, taggedCurrency] = bsheetTag.split('::');
        if (taggedCurrency !== currency || util.convertToUnit(taggedAmount, taggedUnit, unit) !== amount) {
            throw Error('Error! Mismatched transaction and prior balance sheet operation');
        }

        logger('Repeated balance sheet tagging, no need to do more');
        return;
    }

    const wholeCurrencyAmount = util.convertToUnit(amount, unit, 'WHOLE_CURRENCY');

    const transactionDetails = { accountNumber: bSheetReference, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };
    const lambdaPayload = { operation: 'BOOST', transactionDetails };

    const investmentInvocation = {
        FunctionName: config.get('lambdas.addTxToBalanceSheet'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(lambdaPayload)
    };
    
    logger('Payload for balance sheet lambda: ', investmentInvocation);
    const bSheetResult = await lambda.invoke(investmentInvocation).promise();
    logger('Balance sheet result: ', bSheetResult);
    
    const { result } = JSON.parse(bSheetResult['Payload']);
    if (result === 'SUCCESS') {
        logger('Balance sheet completed, tag transaction');
        const updateResult = await persistence.updateTxTags(transactionId, `${bsheetTxTag}::${boostAmount}`);
        logger('Result of tag persistence: ', updateResult);
        return { result: 'SUCCESS' };        
    }

    // would have thrown and logged in balance sheet update too; logging error raises further alarm, but no point
    // throwing at this point (would just duplicate logs / cause spurious retries here but problem is in bsheet handler)
    logger('FATAL_ERROR: Balance sheet update for boost failed: ', bSheetResult);
};
