'use strict';

const logger = require('debug')('jupiter:admin:user');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const persistence = require('./persistence/rds.account');
const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');
const publisher = require('publish-common');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const validKycStatus = ['NO_INFO', 'CONTACT_VERIFIED', 'PENDING_VERIFICATION_AS_PERSON', 'VERIFIED_AS_PERSON', 
    'FAILED_VERIFICATION', 'FLAGGED_FOR_REVIEW', 'PENDING_INFORMATION', 'REVIEW_CLEARED', 'REVIEW_FAILED'];

const validUserStatus = ['CREATED', 'ACCOUNT_OPENED', 'USER_HAS_INITIATED_SAVE', 'USER_HAS_SAVED', 'USER_HAS_WITHDRAWN', 'SUSPENDED_FOR_KYC'];

const validTxStatus = ['INITIATED', 'PENDING', 'SETTLED', 'EXPIRED'];

/**
 * Gets the user counts for the front page, usign a mix of parameters. Leaving out a parameter will invoke a default
 * @param {object} event An event containing the request context and the request body. The body's properties a decribed below.
 * @property {string} startTimeMillis If left out, default is set by config but will generally be six months ago
 * @property {string} endTimeMillis If left out, default is set to now
 * @property {boolean} includeNewButNoSave determines whether to include in the count accounts that were created in the time window but have not yet had a settled save transaction. This can be useful for diagnosing drop outs
 */
module.exports.fetchUserCounts = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    const params = opsCommonUtil.extractQueryParams(event);
    logger('Finding user Ids with params: ', params);

    const defaultDaysBack = config.get('defaults.userCounts.daysBack');

    logger(`Do we have a start time millis ? : ${Reflect.has(params, 'startTimeMillis')}, and it is : ${params.startTimeMillis}`);

    const startTime = Reflect.has(params, 'startTimeMillis') ? moment(parseInt(params.startTimeMillis, 10)) : moment().subtract(defaultDaysBack, 'days');
    const endTime = Reflect.has(params, 'endTimeMillis') ? moment(parseInt(params.endTimeMillis, 10)) : moment();
    const includeNoTxAccountsCreatedInWindow = typeof params.includeNewButNoSave === 'boolean' && params.includeNewButNoSave;

    const userIdCount = await persistence.countUserIdsWithAccounts(startTime, endTime, includeNoTxAccountsCreatedInWindow);

    logger('Obtained user count: ', userIdCount);

    return adminUtil.wrapHttpResponse({ userCount: userIdCount });
};

const fetchUserProfile = async (systemWideUserId) => {
    const profileFetchLambdaInvoke = adminUtil.invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId });
    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    logger('Result of profile fetch: ', profileFetchResult);

    return extractLambdaBody(profileFetchResult);
};

// fetches user events for the last 6 (?) months (... can extend when we have users long than that & have thought through data etc)
const obtainUserHistory = async (systemWideUserId) => {
    const startDate = moment().subtract(config.get('defaults.userHistory.daysInHistory'), 'days').valueOf();
    const eventTypes = config.get('defaults.userHistory.eventTypes');

    const userHistoryEvent = {
        userId: systemWideUserId,
        eventTypes,
        startDate,
        endDate: moment().valueOf()
    };

    const historyInvocation = adminUtil.invokeLambda(config.get('lambdas.userHistory'), userHistoryEvent);
    const historyFetchResult = await lambda.invoke(historyInvocation).promise();
    logger('Result of history fetch: ', historyFetchResult);

    // this one is not wrapped because it is only ever used on direct invocation
    if (historyFetchResult['StatusCode'] !== 200 || JSON.parse(historyFetchResult['Payload']).result !== 'SUCCESS') {
        logger('ERROR! Something went wrong fetching history');
    }

    return JSON.parse(historyFetchResult['Payload']).userEvents;
};

const obtainUserPendingTx = async (systemWideUserId) => {
    logger('Also fetching pending transactions for user ...');
    const startMoment = moment().subtract(config.get('defaults.userHistory.daysInHistory'), 'days');
    return persistence.fetchUserPendingTransactions(systemWideUserId, startMoment);
};

const obtainUserBalance = async (userProfile) => {
    const balancePayload = {
        userId: userProfile.systemWideUserId,
        currency: userProfile.defaultCurrency,
        atEpochMillis: moment().valueOf(),
        timezone: userProfile.defaultTimezone, 
        clientId: userProfile.clientId,
        daysToProject: 0
    };

    const balanceLambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.fetchUserBalance'), balancePayload);

    const userBalanceResult = await lambda.invoke(balanceLambdaInvocation).promise();
    return extractLambdaBody(userBalanceResult);
};

const obtainSystemWideIdFromProfile = async (lookUpPayload) => {
    const lookUpInvoke = adminUtil.invokeLambda(config.get('lambdas.systemWideIdLookup'), lookUpPayload);

    logger('Invoking system wide user ID lookup with params: ', lookUpInvoke);
    const systemWideIdResult = await lambda.invoke(lookUpInvoke).promise();
    const systemIdPayload = JSON.parse(systemWideIdResult['Payload']);
    logger('Result of system wide user ID lookup: ', systemIdPayload);

    if (systemIdPayload.statusCode !== 200) {
        return null;
    }

    const { systemWideUserId } = JSON.parse(systemIdPayload.body);
    logger(`From query params: ${JSON.stringify(lookUpPayload)}, got system ID: ${systemWideUserId}`);
    
    return systemWideUserId;
};

const obtainSystemWideIdFromBankRef = async (lookUpPayload) => {
    logger('Trying to find user from bank reference or account name');
    return persistence.findUserFromRef({ searchValue: lookUpPayload.bankReference, bsheetPrefix: config.get('bsheet.prefix') });
};

/**
 * Function for looking up a user and returning basic data about them
 * @param {object} event An event object containing the request context and query paramaters specifying the search to make
 * @property {object} requestContext As in method above (contains context, from auth, etc)
 * @property {object} queryStringParamaters Contains one of nationalId & country code, phone number, and email address
 */
module.exports.lookUpUser = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const lookUpPayload = opsCommonUtil.extractQueryParams(event);
        logger('Looking up user, with payload: ', lookUpPayload);

        let systemWideUserId = null;
        if (Reflect.has(lookUpPayload, 'bankReference')) {
            systemWideUserId = await obtainSystemWideIdFromBankRef(lookUpPayload);
        } else {
            systemWideUserId = await obtainSystemWideIdFromProfile(lookUpPayload);
        }

        if (!systemWideUserId) {
            return opsCommonUtil.wrapResponse({ result: 'USER_NOT_FOUND' }, status('Not Found'));
        }


        const [userProfile, pendingTransactions, userHistory] = await Promise.all([
            fetchUserProfile(systemWideUserId), obtainUserPendingTx(systemWideUserId), obtainUserHistory(systemWideUserId)
        ]);

        // need profile currency etc for this one, so can't parallel process with above
        const balanceResult = await obtainUserBalance(userProfile);
        const bsheetIdentifier = await persistence.fetchBsheetTag({ accountId: balanceResult.accountId[0], tagPrefix: config.get('bsheet.prefix') });
        const userBalance = { ...balanceResult, bsheetIdentifier };

        const resultObject = { 
            ...userProfile,
            userBalance,
            pendingTransactions,
            userHistory
        };
        
        logger('Returning: ', resultObject);

        return opsCommonUtil.wrapResponse(resultObject);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};

// checking for reason to log is across any update, hence here just check right field and valid type
const validateStatusUpdate = ({ fieldToUpdate, newStatus }) => {
    if (fieldToUpdate === 'KYC' && validKycStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    if (fieldToUpdate === 'STATUS' && validUserStatus.indexOf(newStatus) >= 0) {
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
    } else if (fieldToUpdate === 'STATUS') {
        statusPayload.updatedUserStatus = {
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
    const logPayload = { initiator: adminUserId, options: { context }};
    logger('Dispatching user log: ', logPayload);
    return publisher.publishUserEvent(systemWideUserId, eventType, logPayload);
};

const settleUserTx = async ({ adminUserId, systemWideUserId, transactionId, reasonToLog }) => {
    const settlePayload = { transactionId, paymentRef: reasonToLog, paymentProvider: 'ADMIN_OVERRIDE', settlingUserId: adminUserId };
    logger('Invoking settle lambda, payload: ', settlePayload);
    const settleResponse = await lambda.invoke(adminUtil.invokeLambda(config.get('lambdas.directSettle'), settlePayload)).promise();
    logger('Transaction settle, result: ', settleResponse);

    const resultPayload = JSON.parse(settleResponse['Payload']);
    if (settleResponse['StatusCode'] === 200) {
        const logContext = { settleInstruction: settlePayload, resultPayload };
        const transactionType = resultPayload.transactionDetails[0].transactionType;
        const eventType = transactionType === 'USER_SAVING_EVENT' ? 'ADMIN_SETTLED_SAVE' : `ADMIN_SETTLED_${transactionType}`;
        const loggingPromises = [
            publishUserLog({ adminUserId, systemWideUserId, eventType, context: logContext }),
            persistence.insertAccountLog({ transactionId, adminUserId, logType: eventType, logContext })
        ];
        if (transactionType === 'USER_SAVING_EVENT') {
            loggingPromises.push(publishUserLog({ adminUserId, systemWideUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL', context: logContext }));
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

const handleTxUpdate = async ({ adminUserId, systemWideUserId, transactionId, newTxStatus, reasonToLog }) => {
    logger(`Updating transaction, for user ${systemWideUserId}, transaction ${transactionId}, new status ${newTxStatus}, should log: ${reasonToLog}`);

    let resultBody = { };
    if (newTxStatus === 'SETTLED') {
        resultBody = await settleUserTx({ adminUserId, systemWideUserId, transactionId, reasonToLog });
    } else {
        resultBody = await updateTxStatus({ adminUserId, systemWideUserId, transactionId, newTxStatus, reasonToLog });
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
            logger('Updating a transaction, tell RDS to execute and return');
            if (!params.transactionId || !params.newTxStatus || validTxStatus.indexOf(params.newTxStatus) < 0) {
                return opsCommonUtil.wrapResponse('Error, transaction ID needed and valid transaction status', 400);
            }
            resultOfUpdate = await handleTxUpdate(params);
        }

        if (params.fieldToUpdate === 'KYC' || params.fieldToUpdate === 'STATUS') {
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

        if (opsCommonUtil.isObjectEmpty(resultOfUpdate)) {
            return opsCommonUtil.wrapResponse('Error! Non-standard operation passed', 400);
        }

        return opsCommonUtil.wrapResponse(resultOfUpdate);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};
