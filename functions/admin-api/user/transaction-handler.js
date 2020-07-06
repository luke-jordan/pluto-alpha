'use strict';

const logger = require('debug')('jupiter:admin:user-transaction');
const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const adminUtil = require('../admin.util');
const opsCommonUtil = require('ops-util-common');

const { publishUserLog } = require('./publish-helper');

const validTxStatus = ['INITIATED', 'PENDING', 'SETTLED', 'EXPIRED', 'CANCELLED'];

const initiateTransaction = async ({ params, lambda }) => {
    const { adminUserId, systemWideUserId, transactionParameters } = params;
    const { accountId, amount, unit, currency } = transactionParameters;
    logger('Initiating a transaction with parameters: ', params);

    const lambdaRequestPayload = {
        requestContext: {
            authorizer: { systemWideUserId: adminUserId, role: 'SYSTEM_ADMIN' }
        },
        body: stringify({
            accountId, amount, unit, currency, systemWideUserId
        })
    };

    const lambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.saveInitiate'), lambdaRequestPayload);
    logger('Invoking relevant lambda with invocation: ', lambdaInvocation);
    const lambdaResult = await lambda.invoke(lambdaInvocation).promise();
    logger('Lambda result, raw : ', lambdaResult);

    const lambdaResponsePayload = JSON.parse(lambdaResult['Payload']);
    const saveBody = JSON.parse(lambdaResponsePayload.body);

    return { result: 'SUCCESS', saveDetails: saveBody };
};

// settlement is recorded by here, so this save counts in the count (i.e., no need to increment it here)
const publishSaveSettledLog = async (params, persistence, publisher) => {
    const { adminUserId, systemWideUserId, logContext, transactionId } = params;
    
    const [txDetails, saveCount] = await Promise.all([
        persistence.getTransactionDetails(transactionId), persistence.countTransactionsBySameAccount(transactionId)
    ]);
    
    const context = {
        transactionId,
        accountId: txDetails.accountId,
        timeInMillis: moment().valueOf(),
        bankReference: txDetails.humanReference,
        savedAmount: `${txDetails.amount}::${txDetails.unit}::${txDetails.currency}`,
        firstSave: saveCount === 1,
        saveCount,
        transactionTags: txDetails.tags,
        logContext
    };

    return publishUserLog({ adminUserId, systemWideUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL', context, publisher });
};

const settleUserTx = async ({ params, lambda, publisher, persistence }) => {
    const { adminUserId, systemWideUserId, transactionId, reasonToLog } = params;

    const settlePayload = { transactionId, paymentRef: reasonToLog, paymentProvider: 'ADMIN_OVERRIDE', settlingUserId: adminUserId };
    logger('Invoking settle lambda, payload: ', settlePayload);
    const settleResponse = await lambda.invoke(adminUtil.invokeLambda(config.get('lambdas.directSettle'), settlePayload)).promise();
    logger('Transaction settle, result: ', settleResponse);
    
    const resultPayload = JSON.parse(settleResponse['Payload']);
    if (settleResponse['StatusCode'] === 200) {
        const logContext = { settleInstruction: settlePayload, resultPayload };
        const transactionType = resultPayload.transactionDetails[0].accountTransactionType;
        const eventType = transactionType === 'USER_SAVING_EVENT' ? 'ADMIN_SETTLED_SAVE' : `ADMIN_SETTLED_${transactionType}`;
        
        const loggingPromises = [
            publishUserLog({ adminUserId, systemWideUserId, eventType, context: logContext, publisher }),
            persistence.insertAccountLog({ transactionId, adminUserId, logType: eventType, logContext })
        ];

        if (transactionType === 'USER_SAVING_EVENT') {
            // this both publishes the specific event (important for boost processing and much else), and records the account log
            const logParams = { adminUserId, systemWideUserId, logContext, transactionId };
            const settleLog = publishSaveSettledLog(logParams, persistence, publisher);
            loggingPromises.push(settleLog);
        }

        await Promise.all(loggingPromises);
        return { result: 'SUCCESS', updateLog: resultPayload };
    } 
    
    return { result: 'ERROR', message: resultPayload };
};

/**
 * Updates a transaction status when it is relatively inconsequential (i.e., is _not_ a settle)
 */
const updateTxStatus = async ({ params, publisher, persistence }) => {
    const { adminUserId, systemWideUserId, transactionId, newTxStatus, reasonToLog } = params;

    const logContext = { performedBy: adminUserId, owningUserId: systemWideUserId, reason: reasonToLog, newStatus: newTxStatus };
    const resultOfRdsUpdate = await persistence.adjustTxStatus({ transactionId, newTxStatus, logContext });

    logger('Result of straight persistence adjustment: ', resultOfRdsUpdate);
    await Promise.all([
        publishUserLog({ adminUserId, systemWideUserId, eventType: 'ADMIN_UPDATED_TX', context: { ...logContext, transactionId }, publisher }),
        persistence.insertAccountLog({ transactionId, adminUserId, logType: 'ADMIN_UPDATED_TX', logContext })
    ]);

    return { result: 'SUCCESS', updateLog: resultOfRdsUpdate };
};

const updateTxAmount = async ({ params, publisher, persistence }) => {
    const { adminUserId, systemWideUserId, transactionId, newAmount, reasonToLog } = params;
    const currentTx = await persistence.getTransactionDetails(transactionId);
    
    logger('Updating transaction, new amount: ', newAmount);
    logger('And prior transaction details: ', currentTx);

    if (!newAmount.currency || newAmount.currency !== currentTx.currency) {
        throw Error('Currency switching is not allowed yet, and currency must be supplied');
    }
    if (!newAmount.unit || !newAmount.amount) {
        throw Error('New amount must supply unit and amount');
    }
    const oldAmount = { amount: currentTx.amount, unit: currentTx.unit, currency: currentTx.currency };
    const resultOfUpdate = await persistence.adjustTxAmount({ transactionId, newAmount });
    logger('Result of amount adjustment: ', resultOfUpdate);
    
    const updatedTime = moment(resultOfUpdate.updatedTime);
    
    const userEventLogOptions = {
        initiator: adminUserId,
        timestamp: updatedTime.valueOf(),
        context: {
            transactionId,
            accountId: currentTx.accountId,
            transactionType: currentTx.transactionType,
            transactionStatus: currentTx.settlementStatus,
            humanReference: currentTx.humanReference,
            timeInMillis: updatedTime.valueOf(),
            newAmount,
            oldAmount,
            reason: reasonToLog
        }
    };

    const accountLog = {
        transactionId,
        accountId: currentTx.accountId,
        adminUserId,
        logType: 'ADMIN_UPDATED_TX',
        logContext: { reason: reasonToLog, oldAmount, newAmount }
    };

    await Promise.all([
        publisher.publishUserEvent(systemWideUserId, 'ADMIN_UPDATED_TX', userEventLogOptions),
        persistence.insertAccountLog(accountLog)
    ]);
    return { result: 'SUCCESS', updateLog: resultOfUpdate };
};

const validateTxUpdate = ({ transactionId, newTxStatus, newAmount }) => {
    if (!transactionId) {
        return opsCommonUtil.wrapResponse('Error, transaction ID required if not initiating transaction', 400);
    }

    if (!newTxStatus && !newAmount) {
        return opsCommonUtil.wrapResponse('Must adjust update status or amount', 400);
    }
    
    if (newTxStatus && validTxStatus.indexOf(newTxStatus) < 0) {
        return opsCommonUtil.wrapResponse('Error, invalid transaction status', 400);
    }

    return false;
};

const validateTxInitiate = (parameters) => {
    const requiredParams = ['accountId', 'amount', 'unit', 'currency', 'transactionType'];
    const missingParams = requiredParams.filter((param) => !Object.keys(parameters).includes(param));
    if (missingParams.length > 0) {
        return opsCommonUtil.wrapResponse(`Error missing parameters: ${missingParams.join(', ')}`, 400);
    }

    return false;
};

// todo : clean this up to operation/parameters style
const validateTxOperation = ({ operation, transactionId, newTxStatus, newAmount, transactionParameters }) => {
    if (operation === 'INITIATE' && transactionParameters) {
        return validateTxInitiate(transactionParameters);
    }
    
    return validateTxUpdate({ transactionId, newTxStatus, newAmount });
};

const handleTxUpdate = async ({ params, publisher, persistence, lambda }) => {
    const { systemWideUserId, transactionId, newTxStatus, newAmount, reasonToLog } = params;
    logger(`Updating transaction, for user ${systemWideUserId}, transaction ${transactionId}, new status ${newTxStatus}, should log: ${reasonToLog}`);

    let resultBody = { };    
    if (newTxStatus === 'SETTLED') {
        resultBody = await settleUserTx({ params, publisher, persistence, lambda });
    } else if (newTxStatus) {
        resultBody = await updateTxStatus({ params, publisher, persistence });
    } else if (newAmount && newAmount.amount) {
        resultBody = await updateTxAmount({ params, publisher, persistence });
    }

    logger('Completed transaction update, result: ', resultBody);
    return resultBody;
};

module.exports.processTransaction = async ({ params, publisher, persistence, lambda }) => {
    logger('Updating or initiating a transaction');
    const checkForError = validateTxOperation(params);
    if (checkForError) {
        return checkForError;
    }

    if (params.transactionId) {
        return handleTxUpdate({ params, publisher, persistence, lambda });
    }

    return initiateTransaction({ params, lambda });
};
