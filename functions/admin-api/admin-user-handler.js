'use strict';

const logger = require('debug')('jupiter:admin:rds');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const persistence = require('./persistence/rds.account');
const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');

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
    if (historyFetchResult['StatusCode'] !== 200 || JSON.parse(historyFetchResult['Payload']).result !== 'success') {
        logger('ERROR! Something went wrong fetching history');
    }

    return JSON.parse(historyFetchResult['Payload']).userEvents;
};

const obtainUserPendingTx = async (systemWideUserId) => {
    // todo : make sure includes withdrawals
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
        const lookUpInvoke = adminUtil.invokeLambda(config.get('lambdas.systemWideIdLookup'), lookUpPayload);

        logger('Invoking system wide user ID lookup with params: ', lookUpInvoke);
        const systemWideIdResult = await lambda.invoke(lookUpInvoke).promise();
        const systemIdPayload = JSON.parse(systemWideIdResult['Payload']);

        if (systemIdPayload.statusCode !== 200) {
            return opsCommonUtil.wrapResponse({ result: 'USER_NOT_FOUND' }, status('Not Found'));
        }

        const { systemWideUserId } = JSON.parse(systemIdPayload.body);
        logger(`From query params: ${JSON.stringify(lookUpPayload)}, got system ID: ${systemWideUserId}`);

        const [userProfile, pendingTransactions, userHistory] = await Promise.all([
            fetchUserProfile(systemWideUserId), obtainUserPendingTx(systemWideUserId), obtainUserHistory(systemWideUserId)
        ]);

        // need profile currency etc for this one, so can't parallel process with above
        const userBalance = await obtainUserBalance(userProfile);

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
    const updatePayload = updateResult['Payload'];
    
    const returnResult = updatePayload.statusCode === 200
        ? { result: 'SUCCESS', updateLog: JSON.parse(updatePayload.body) }
        : { result: 'FAILURE', message: JSON.parse(updatePayload.body)};

    logger('Returning result: ', returnResult);

    return updateResult;
};

const handleTxUpdate = async ({ adminUserId, systemWideUserId, transactionId, newTxStatus, reasonToLog }) => {
    // todo : definitely need audit tables to do something with the logs
    logger(`Updating transaction, for user ${systemWideUserId}, should log: ${reasonToLog}`);

    let resultBody = { };
    if (newTxStatus === 'SETTLED') {
        const settlePayload = { transactionId, paymentRef: reasonToLog, paymentProvider: 'ADMIN_OVERRIDE' };
        const settleResponse = await lambda.invoke(adminUtil.invokeLambda(config.get('lambdas.directSettle'), settlePayload)).promise();
        const resultPayload = settleResponse['Payload'];
        if (resultPayload.statusCode === 200) {
            resultBody = { result: 'SUCCESS', updateLog: JSON.parse(resultPayload.body) };
        } else {
            resultBody = { result: 'ERROR', message: JSON.parse(resultPayload.body) };
        }
    } else {
        const logContext = { performedBy: adminUserId, owningUserId: systemWideUserId, reasong: reasonToLog };
        const resultOfRdsUpdate = await persistence.adjustTxStatus({ transactionId, newTxStatus, logContext });
        logger('Result of straight persistence adjustment: ', resultOfRdsUpdate);
        resultBody = { result: 'SUCCESS', updateLog: resultOfRdsUpdate };
    }

    logger('Completed transaction update, result: ', resultBody);
    return resultBody;
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

        const params = opsCommonUtil.extractParamsFromEvent(event);
        logger('Params for user management: ', event);

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

        if (opsCommonUtil.isObjectEmpty(resultOfUpdate)) {
            return opsCommonUtil.wrapResponse('Error! Non-standard operation passed', 400);
        }

        return opsCommonUtil.wrapResponse(resultOfUpdate);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};
