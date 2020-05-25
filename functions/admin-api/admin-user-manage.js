'use strict';

const logger = require('debug')('jupiter:admin:user');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds.account');
const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');
const publisher = require('publish-common');

const stringify = require('json-stable-stringify');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const validKycStatus = ['NO_INFO', 'CONTACT_VERIFIED', 'PENDING_VERIFICATION_AS_PERSON', 'VERIFIED_AS_PERSON', 
    'FAILED_VERIFICATION', 'FLAGGED_FOR_REVIEW', 'PENDING_INFORMATION', 'REVIEW_CLEARED', 'REVIEW_FAILED'];

const validUserStatus = ['CREATED', 'ACCOUNT_OPENED', 'USER_HAS_INITIATED_SAVE', 'USER_HAS_SAVED', 'USER_HAS_WITHDRAWN', 'SUSPENDED_FOR_KYC'];

const validRegulatoryStatus = ['REQUIRES_AGREEMENT', 'HAS_GIVEN_AGREEMENT'];

const validTxStatus = ['INITIATED', 'PENDING', 'SETTLED', 'EXPIRED', 'CANCELLED'];

// duplicated from user-query but short and to the point and small price to pay
const fetchUserProfile = async (systemWideUserId, includeContactMethod = true) => {
    const profileFetchLambdaInvoke = adminUtil.invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId, includeContactMethod });
    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    return extractLambdaBody(profileFetchResult);
};

// checking for reason to log is across any update, hence here just check right field and valid type
const validateStatusUpdate = ({ fieldToUpdate, newStatus }) => {
    if (fieldToUpdate === 'KYC' && validKycStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    if (fieldToUpdate === 'STATUS' && validUserStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    if (fieldToUpdate === 'REGULATORY' && validRegulatoryStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    return false;
};

const handleStatusUpdate = async ({ adminUserId, systemWideUserId, fieldToUpdate, newStatus, reasonToLog }) => {
    const statusPayload = { systemWideUserId, initiator: adminUserId };
    
    if (fieldToUpdate === 'KYC') {
        statusPayload.updatedKycStatus = {
            changeTo: newStatus,
            reasonToLog
        };
    } 
    
    if (fieldToUpdate === 'STATUS') {
        statusPayload.updatedUserStatus = {
            changeTo: newStatus,
            reasonToLog
        };
    }

    if (fieldToUpdate === 'REGULATORY') {
        statusPayload.updatedRegulatoryStatus = {
            changeTo: newStatus,
            reasonToLog
        };
    }

    const updateInvoke = adminUtil.invokeLambda(config.get('lambdas.statusUpdate'), statusPayload);
    const updateResult = await lambda.invoke(updateInvoke).promise();
    logger('Result from status update Lambda: ', updateResult);
    const updatePayload = JSON.parse(updateResult['Payload']);
    
    const returnResult = updatePayload.statusCode === 200
        ? { result: 'SUCCESS', updateLog: JSON.parse(updatePayload.body) }
        : { result: 'FAILURE', message: JSON.parse(updatePayload.body) };

    logger('Returning result: ', returnResult);

    return returnResult;
};

const publishUserLog = async ({ adminUserId, systemWideUserId, eventType, context }) => {
    const logOptions = { initiator: adminUserId, context };
    logger('Dispatching user log of event type: ', eventType, ', with log options: ', logOptions);
    return publisher.publishUserEvent(systemWideUserId, eventType, logOptions);
};

const initiateTransaction = async (systemWideUserId, parameters, requestContext) => {
    logger('Initiating a transaction with parameters: ', parameters);

    const { accountId, amount, unit, currency } = parameters;
    const lambdaRequestPayload = {
        requestContext,
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
const publishSaveSettledLog = async ({ adminUserId, systemWideUserId, logContext, transactionId }) => {
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
        logContext
    };

    return publishUserLog({ adminUserId, systemWideUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL', context });
};

const settleUserTx = async ({ adminUserId, systemWideUserId, transactionId, reasonToLog }) => {
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
            publishUserLog({ adminUserId, systemWideUserId, eventType, context: logContext }),
            persistence.insertAccountLog({ transactionId, adminUserId, logType: eventType, logContext })
        ];
        if (transactionType === 'USER_SAVING_EVENT') {
            loggingPromises.push(publishSaveSettledLog({ adminUserId, systemWideUserId, logContext, transactionId }));
        }
        await Promise.all(loggingPromises);
        return { result: 'SUCCESS', updateLog: resultPayload };
    } 
    
    return { result: 'ERROR', message: resultPayload };
};

const updateTxStatus = async ({ adminUserId, systemWideUserId, transactionId, newTxStatus, reasonToLog }) => {
    const logContext = { performedBy: adminUserId, owningUserId: systemWideUserId, reason: reasonToLog, newStatus: newTxStatus };
    const resultOfRdsUpdate = await persistence.adjustTxStatus({ transactionId, newTxStatus, logContext });
    logger('Result of straight persistence adjustment: ', resultOfRdsUpdate);
    await Promise.all([
        publishUserLog({ adminUserId, systemWideUserId, eventType: 'ADMIN_UPDATED_TX', context: { ...logContext, transactionId }}),
        persistence.insertAccountLog({ transactionId, adminUserId, logType: 'ADMIN_UPDATED_TX', logContext })
    ]);
    return { result: 'SUCCESS', updateLog: resultOfRdsUpdate };
};

const updateTxAmount = async ({ adminUserId, systemWideUserId, transactionId, newAmount, reasonToLog }) => {
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
const validateTxOperation = ({ operation, transactionId, newTxStatus, newAmount, parameters }) => {
    if (operation === 'INITIATE' && parameters) {
        return validateTxInitiate(parameters);
    }
    
    return validateTxUpdate({ transactionId, newTxStatus, newAmount });
};

const handleTxUpdate = async ({ adminUserId, systemWideUserId, transactionId, newTxStatus, newAmount, reasonToLog }) => {
    logger(`Updating transaction, for user ${systemWideUserId}, transaction ${transactionId}, new status ${newTxStatus}, should log: ${reasonToLog}`);

    let resultBody = { };    
    if (newTxStatus === 'SETTLED') {
        resultBody = await settleUserTx({ adminUserId, systemWideUserId, transactionId, reasonToLog });
    } else if (newTxStatus) {
        resultBody = await updateTxStatus({ adminUserId, systemWideUserId, transactionId, newTxStatus, reasonToLog });
    } else if (newAmount && newAmount.amount) {
        resultBody = await updateTxAmount({ adminUserId, systemWideUserId, transactionId, newAmount, reasonToLog });
    }

    logger('Completed transaction update, result: ', resultBody);
    return resultBody;
};

const handleBsheetAccUpdate = async ({ adminUserId, systemWideUserId, accountId, newIdentifier }) => {
    logger(`Updating balance sheet account for ${systemWideUserId}, setting it to ${newIdentifier}`);
    const bsheetPrefix = config.get('bsheet.prefix');
    // happens inside to prevent accidental duplication etc
    const resultOfRdsUpdate = await persistence.updateBsheetTag({ accountId, tagPrefix: bsheetPrefix, newIdentifier });
    logger('Result of RDS update: ', resultOfRdsUpdate);
    if (!resultOfRdsUpdate) {
        return { result: 'ERROR', message: 'Failed on persistence update' };
    }
    
    const oldIdentifier = resultOfRdsUpdate.oldIdentifier;
    const logContext = { performedBy: adminUserId, owningUserId: systemWideUserId, newIdentifier, oldIdentifier };

    await Promise.all([
        publishUserLog({ adminUserId, systemWideUserId, eventType: 'ADMIN_UPDATED_BSHEET_TAG', context: { ...logContext, accountId } }),
        persistence.insertAccountLog({ accountId, adminUserId, logType: 'ADMIN_UPDATED_BSHEET_TAG', logContext })
    ]);
    return { result: 'SUCCESS', updateLog: resultOfRdsUpdate };
};

const handlePwdUpdate = async (params, requestContext) => {
    const { adminUserId, systemWideUserId } = params;
    const updatePayload = { systemWideUserId, generateRandom: true, requestContext };
    logger('Invoking password update lambda, payload: ', updatePayload);
    const updateResult = await lambda.invoke(adminUtil.invokeLambda(config.get('lambdas.passwordUpdate'), updatePayload)).promise();
    logger('Password update result: ', updateResult);

    const resultPayload = JSON.parse(updateResult['Payload']);
    if (updateResult['StatusCode'] === 200) {
        const resultBody = JSON.parse(resultPayload.body);
        if (!Reflect.has(resultBody, 'newPassword')) {
            return { result: 'ERROR', message: 'Failed on new password generation' };
        }
        
        const { newPassword } = resultBody;
        const dispatchMsg = `Your password has been successfully reset. Please use the following ` +
            `password to login to your account: ${newPassword}. Please create a new password once logged in.`;
        const userProfile = await fetchUserProfile(systemWideUserId, true);
        
        let dispatchResult = null;

        if (config.has('defaults.pword.mock.enabled') && config.get('defaults.pword.mock.enabled')) {
            userProfile.phoneNumber = userProfile.phoneNumber ? config.get('defaults.pword.mock.phone') : null;
            userProfile.emailAddress = userProfile.emailAddress ? config.get('defaults.pword.mock.email') : null;
        }

        if (userProfile.emailAddress) {
            dispatchResult = await publisher.sendSystemEmail({
                subject: 'Jupiter Password',
                toList: [userProfile.emailAddress],
                bodyTemplateKey: config.get('email.pwdReset.templateKey'),
                templateVariables: { pwd: newPassword }
            });
        } else if (userProfile.phoneNumber) {
            dispatchResult = await publisher.sendSms({ phoneNumber: `+${userProfile.phoneNumber}`, message: dispatchMsg });
        }

        await publishUserLog({ adminUserId, systemWideUserId, eventType: 'PASSWORD_RESET', context: { dispatchResult } });

        return { result: 'SUCCESS', updateLog: { dispatchResult }};
    }
   
    return { result: 'ERROR', message: resultPayload };
};

/**
 * @property {string} systemWideUserId The ID of the user to adjust
 * @property {string} fieldToUpdate One of: KYC, STATUS, TRANSACTION 
 */
module.exports.manageUser = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const adminUserId = opsCommonUtil.extractUserDetails(event).systemWideUserId;

        const params = { ...opsCommonUtil.extractParamsFromEvent(event), adminUserId };
        logger('Params for user management: ', params);

        if (!params.systemWideUserId || !params.fieldToUpdate || !params.reasonToLog) {
            const message = 'Requests must include a user ID to update, a field, and a reason to log';
            return opsCommonUtil.wrapResponse(message, 400);
        }

        let resultOfUpdate = { };
        if (params.fieldToUpdate === 'TRANSACTION') {
            logger('Updating or initiating a transaction');
            const checkForError = validateTxOperation(params);
            logger('Do we have an error ? : ', checkForError);
            if (checkForError) {
                return checkForError;
            }


            resultOfUpdate = await (params.transactionId 
                ? handleTxUpdate(params) 
                : initiateTransaction(params.systemWideUserId, params.parameters, event.requestContext)
            );
        }

        if (params.fieldToUpdate === 'KYC' || params.fieldToUpdate === 'STATUS' || params.fieldToUpdate === 'REGULATORY') {
            logger('Updating user status, validate types and return okay');
            if (!validateStatusUpdate(params)) {
                return opsCommonUtil.wrapResponse('Error, bad field or type for user update', 400);
            }
            resultOfUpdate = await handleStatusUpdate(params);
        }
        
        if (params.fieldToUpdate === 'BSHEET') {
            logger('Updating the FinWorks (balance sheet management) identifier for the user');
            if (!params.accountId) {
                return opsCommonUtil.wrapResponse('Error, must pass in account ID', 400);
            }
            if (!params.newIdentifier) {
                return opsCommonUtil.wrapResponse('Error, must pass in newIdentifier', 400);
            }
            resultOfUpdate = await handleBsheetAccUpdate(params);
        }

        if (params.fieldToUpdate === 'PWORD') {
            logger('Resetting the user password, trigger and send back');
            resultOfUpdate = await handlePwdUpdate(params, event.requestContext);
        }

        if (opsCommonUtil.isObjectEmpty(resultOfUpdate)) {
            return opsCommonUtil.wrapResponse('Error! Non-standard operation passed', 400);
        }

        return opsCommonUtil.wrapResponse(resultOfUpdate);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};
