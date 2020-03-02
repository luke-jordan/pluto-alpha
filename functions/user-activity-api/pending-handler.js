'use strict';

const logger = require('debug')('jupiter:pending:main');

const opsUtil = require('ops-util-common');
const moment = require('moment');

const savingHandler = require('./saving-handler');
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

const handlePendingSaveCheck = async ({ transactionId, settlementStatus, settlementTime }) => {
    if (settlementStatus === 'SETTLED') {
        const transactionLogs = await rds.fetchLogsForTransaction(transactionId);
        const wasAdminSettled = transactionLogs.find((log) => log.logType === 'ADMIN_SETTLED_SAVE');
        const result = wasAdminSettled ? 'ADMIN_MARKED_PAID' : 'PAYMENT_SUCCEEDED';
        const settlementTimeMillis = moment(settlementTime).valueOf();
        return { statusCode: 200, body: JSON.stringify({ result, settlementTimeMillis })};
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

    const { transactionType, settlementStatus, settlementTime } = txDetails;

    if (transactionType === 'USER_SAVING_EVENT') {
        return handlePendingSaveCheck({ transactionId, settlementStatus, settlementTime });
    }
    
    if (transactionType === 'WITHDRAWAL') {
        return { statusCode: 200, body: JSON.stringify({ result: `WITHDRAWAL_${settlementStatus}` })};
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'BAD_TRANSACTION_TYPE' })};
};

const getPendingxTx = async (systemWideUserId) => {
    const userAccounts = await rds.findAccountsForUser(systemWideUserId);
    const currentPending = await rds.fetchPendingTransactions(userAccounts[0]);
    return { statusCode: 200, body: JSON.stringify({ pending: currentPending })};
};

module.exports.handlePendingTxEvent = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = opsUtil.extractUserDetails(event);
        const { operation, params } = opsUtil.extractPathAndParams(event);

        logger(`Handling pending transaction, user Id: ${systemWideUserId}, operation: ${operation}, parameters: ${JSON.stringify(params)}`);

        const { transactionId } = params;

        // if no transaction ID, get the details for the latest transaction and return them
        if (operation === 'list' || !transactionId) {
            return getPendingxTx(systemWideUserId);
        }
        
        if (operation === 'cancel') {
            return cancelTransaction({ transactionId, systemWideUserId });
        } else if (operation === 'check') {
            return recheckTransaction({ transactionId, systemWideUserId });
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'UNKNOWN_OPERATION' })};
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err.message) };
    }
};
