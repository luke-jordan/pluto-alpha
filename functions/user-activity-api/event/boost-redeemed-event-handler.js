'use strict';

const logger = require('debug')('jupiter:event:boost');
const config = require('config');

const util = require('ops-util-common');

// todo : make this idempotent by tagging the transaction
module.exports.handleBoostRedeemedEvent = async ({ eventBody, persistence, publisher }) => {
    logger('Handling boost redeemed event: ', JSON.stringify(eventBody));
    const { accountId, boostAmount, transferResults } = eventBody.context;

    const [unparsedAmount, unit, currency] = boostAmount.split('::');
    const amount = parseInt(unparsedAmount, 10);
    if (amount === 0) {
        logger('FATAL_ERROR: Zero boost provided to boost redeemed'); // just to keep an eye for the moment
        return;
    }

    if (!transferResults || !Array.isArray(transferResults.accountTxIds) || transferResults.accountTxIds.length === 0) {
        throw Error('Error! Malformed event context, no transaction ID');
    }

    // if this is a tournament we need to find the transaction that belongs to this account
    // note : could do a bulk query but (1) usually this will be 3-4 transactions max, and happen once a day, and on background thread
    const txFetchResults = await Promise.all(transferResults.accountTxIds.map((transactionId) => persistence.fetchTransaction(transactionId)));
    const txDetails = txFetchResults.find((txResult) => txResult.accountId === accountId);
    if (!txDetails) {
        throw Error('Error! Account does not match any transaction in the transfer');
    }

    logger('Retrieved transaction matching to this boost redemption: ', txDetails);
    
    const bsheetTxTag = config.get('defaults.balanceSheet.txTagPrefix');
    const bsheetTag = txDetails.tags.find((tag) => tag.startsWith(bsheetTxTag));
    
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

    const bSheetReference = await persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'));
    const transactionDetails = { accountNumber: bSheetReference, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };
    const queuePayload = { operation: 'BOOST', transactionDetails };
    
    logger('Payload for balance sheet queue: ', queuePayload);
    const bSheetResult = await publisher.sendToQueue(config.get('queues.balanceSheetUpdate'), [queuePayload], true);
    logger('Result of queuing: ', bSheetResult);
    
    // as far as this handler is concerned, its work is done and should not be repeated, errors in bsheet handler
    // should go via its dlq etc and be picked up there, _unless_ it was the very act of sending to the queue that failed

    if (!bSheetResult || bSheetResult.result === 'FAILURE') {
        logger('FATAL ERR: Error sending boost redemption to balance sheet queue: ', bSheetResult);
        return;
    }

    const updateResult = await persistence.updateTxTags(txDetails.transactionId, `${bsheetTxTag}::${boostAmount}`);
    logger('Result of tag persistence: ', updateResult);
};
