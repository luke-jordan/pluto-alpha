'use strict';

const logger = require('debug')('jupiter:pending:main');

const opsUtil = require('ops-util-common');
const moment = require('moment');

const savingHandler = require('./saving-handler');
const payment = require('./payment-link');
const floatVars = require('./persistence/dynamodb');

const rds = require('./persistence/rds');
const publisher = require('publish-common');

const cancelTransaction = async ({ transactionId, systemWideUserId }) => {
    const txDetails = await rds.fetchTransaction(transactionId);
    logger('Fetched transaction to cancel: ', txDetails);
    if (!txDetails) {
        return { statusCode: 400, body: JSON.stringify({ error: 'NO_TRANSACTION_FOUND' })};
    }

    const { accountId, transactionType, settlementStatus: oldStatus } = txDetails;
    if (oldStatus === 'SETTLED') {
        return { statusCode: 400, body: JSON.stringify({ error: 'ALREADY_SETTLED' })};
    }

    const logContext = { oldStatus, newStatus: 'CANCELLED' };
    const logToInsert = {
        accountId,
        systemWideUserId,
        referenceTime: moment(),
        logContext
    };

    const resultOfUpdate = await rds.updateTxSettlementStatus({ transactionId, settlementStatus: 'CANCELLED', logToInsert });
    logger('Result of updating transaction: ', resultOfUpdate);

    // don't want to publish unless successful, so do this after instead of in parallel
    if (transactionType === 'WITHDRAWAL') {
        await publisher.publishUserEvent(systemWideUserId, 'WITHDRAWAL_EVENT_CANCELLED', { context: { transactionId, ...logContext } });
    } else if (transactionType === 'USER_SAVING_EVENT') {
        await publisher.publishUserEvent(systemWideUserId, 'SAVING_EVENT_CANCELLED', { context: { transactionId, ...logContext } });
    }

    return { statusCode: 200, body: JSON.stringify({ result: 'SUCCESS' }) };
};

const handlePendingSaveCheck = async ({ transactionId, settlementStatus, settlementTime, accountId, currency }) => {
    if (settlementStatus === 'SETTLED') {
        const [transactionLogs, newBalance] = await Promise.all([
            rds.fetchLogsForTransaction(transactionId),
            rds.sumAccountBalance(accountId, currency)
        ]);
        const wasAdminSettled = transactionLogs.find((log) => log.logType === 'ADMIN_SETTLED_SAVE');
        const result = wasAdminSettled ? 'ADMIN_MARKED_PAID' : 'PAYMENT_SUCCEEDED';
        const settlementTimeMillis = moment(settlementTime).valueOf();
        return { statusCode: 200, body: JSON.stringify({ result, settlementTimeMillis, newBalance })};
    }

    if (settlementStatus === 'CANCELLED') {
        const transactionLogs = await rds.fetchLogsForTransaction(transactionId);
        const didAdminCancel = transactionLogs.find((log) => log.logType === 'ADMIN_UPDATED_TX');
        const result = didAdminCancel ? 'ADMIN_CANCELLED' : 'USER_CANCELLED';
        const settlementTimeMillis = moment(settlementTime).valueOf();
        return { statusCode: 200, body: JSON.stringify({ result, settlementTimeMillis }) };
    }

    return savingHandler.checkPendingPayment({ transactionId });
};

const recheckTransaction = async ({ transactionId, systemWideUserId }) => {
    const txDetails = await rds.fetchTransaction(transactionId);
    logger('For user ID: ', systemWideUserId, 'fetched transaction to recheck: ', txDetails);
    if (!txDetails) {
        return { statusCode: 400, body: JSON.stringify({ error: 'NO_TRANSACTION_FOUND' })};
    }

    const { transactionType, settlementStatus } = txDetails;

    if (transactionType === 'USER_SAVING_EVENT') {
        return handlePendingSaveCheck(txDetails);
    }
    
    if (transactionType === 'WITHDRAWAL') {
        return { statusCode: 200, body: JSON.stringify({ result: `WITHDRAWAL_${settlementStatus}` })};
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'BAD_TRANSACTION_TYPE' })};
};

const extractPaymentLink = (transactionDetails) => {
    if (!transactionDetails.tags || transactionDetails.tags.length === 0) {
        logger('Transaction has no flags, exit', transactionDetails.falgs);
        return '';
    }

    logger('Extracting payment link from flags: ', transactionDetails.flags);
    const paymentLinkTag = transactionDetails.tags.find((tag) => tag.startsWith('PAYMENT_URL::'));
    return paymentLinkTag ? paymentLinkTag.substring('PAYMENT_URL::'.length) : '';
};

const generatePaymentLink = async (transactionDetails) => {
    logger('Generating payment link for: ', transactionDetails);
    const accountStemAndCount = await rds.fetchInfoForBankRef(transactionDetails.accountId);
    const accountInfo = {
        bankRefStem: accountStemAndCount.humanRef,
        priorSaveCount: accountStemAndCount.count
    };
    
    const amountDict = {
        amount: transactionDetails.amount,
        unit: transactionDetails.unit,
        currency: transactionDetails.currency
    };
    
    const paymentLinkResult = await payment.getPaymentLink({ transactionId: transactionDetails.transactionId, accountInfo, amountDict });
    logger('Got payment link result: ', paymentLinkResult);
    const urlToCompletePayment = paymentLinkResult.paymentUrl;

    logger('Returning with url to complete payment: ', urlToCompletePayment);
    return { urlToCompletePayment, paymentDetails: paymentLinkResult };
};

const updateTxToInstantEft = async (transactionDetails) => {
    const resultBody = { humanReference: transactionDetails.humanReference, transactionDetails };
    const priorPaymentLink = extractPaymentLink(transactionDetails);
    
    if (transactionDetails.paymentProvider === 'OZOW' && priorPaymentLink.length > 0) {
        logger('Already set, just return params');
        resultBody.paymentRedirectDetails = { urlToCompletePayment: priorPaymentLink };
    } else if (priorPaymentLink.length > 0) {
        // just update method
        resultBody.paymentRedirectDetails = { urlToCompletePayment: priorPaymentLink };
        const updateParams = { transactionId: transactionDetails.transactionId, paymentProvider: 'OZOW' };
        const resultOfUpdate = await rds.addPaymentInfoToTx(updateParams);
        logger('Updated provider: ', resultOfUpdate);
    } else {
        // generate a link and update
        const { urlToCompletePayment, paymentDetails } = await generatePaymentLink(transactionDetails);
        resultBody.paymentRedirectDetails = { urlToCompletePayment };
        resultBody.humanReference = paymentDetails.bankRef;
        const updateParams = { transactionId: transactionDetails.transactionId, ...paymentDetails, paymentProvider: 'OZOW' };
        const resultOfUpdate = await rds.addPaymentInfoToTx(updateParams);
        logger('Updated successfully? : ', resultOfUpdate);
    }

    return { statusCode: 200, body: JSON.stringify(resultBody) };
};

const updateTxToManualEft = async (transactionDetails) => {
    const resultBody = { humanReference: transactionDetails.humanReference, transactionDetails };
    const { bankDetails } = await floatVars.fetchFloatVarsForBalanceCalc(transactionDetails.clientId, transactionDetails.floatId);
    logger('Retrived bank details from float: ', bankDetails);
    resultBody.bankDetails = bankDetails;

    if (transactionDetails.paymentProvider !== 'MANUAL_EFT') {
        const updateParams = { transactionId: transactionDetails.transactionId, paymentProvider: 'MANUAL_EFT' };
        const resultOfUpdate = await rds.addPaymentInfoToTx(updateParams);
        logger('Result of updating to manual method: ', resultOfUpdate);
    }

    return { statusCode: 200, body: JSON.stringify(resultBody) };
};

const updateTx = async (params) => {
    const { transactionId } = params;
    const transactionDetails = await rds.fetchTransaction(transactionId);
    logger('Alright updating this transaction: ', transactionDetails);

    if (!transactionDetails || transactionDetails.transactionType !== 'USER_SAVING_EVENT') {
        return { statusCode: 400, body: JSON.stringify({ message: 'Transaction is not a save' })};
    }

    if (transactionDetails.settlementStatus === 'SETTLED') {
        return { statusCode: 200, body: JSON.stringify({ settlementStatus: 'SETTLED' }) };
    }

    const { paymentMethod } = params;
    logger('Updating transaction to have payment provider: ', paymentMethod);

    if (paymentMethod === 'OZOW') {
        return updateTxToInstantEft(transactionDetails);
    } else if (paymentMethod === 'MANUAL_EFT') {
        return updateTxToManualEft(transactionDetails);
    }

    return { statusCode: 400, body: JSON.stringify({ message: 'Unsupported payment provider' })};
};

const getPendingxTx = async (systemWideUserId) => {
    const userAccounts = await rds.findAccountsForUser(systemWideUserId);
    const currentPending = await rds.fetchPendingTransactions(userAccounts[0]);
    return { statusCode: 200, body: JSON.stringify({ pending: currentPending })};
};

const dispatcher = {
    'list': ({ systemWideUserId }) => getPendingxTx(systemWideUserId),
    'cancel': ({ transactionId, systemWideUserId }) => cancelTransaction({ transactionId, systemWideUserId }),
    'check': ({ transactionId, systemWideUserId }) => recheckTransaction({ transactionId, systemWideUserId }),
    'update': (params) => updateTx(params)
};

module.exports.handlePendingTxEvent = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = opsUtil.extractUserDetails(event);
        const { operation, params } = opsUtil.extractPathAndParams(event);

        logger(`Handling pending transaction, user Id: ${systemWideUserId}, operation: ${operation}, parameters: ${JSON.stringify(params)}`);
        if (!Object.keys(dispatcher).includes(operation)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'UNKNOWN_OPERATION' })};
        }

        const resultOfProcess = await dispatcher[operation.trim().toLowerCase()]({ systemWideUserId, ...params });
        logger('And now returning: ', resultOfProcess);

        return resultOfProcess;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};
