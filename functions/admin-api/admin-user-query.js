'use strict';

const logger = require('debug')('jupiter:admin:user');
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

const fetchUserProfile = async (systemWideUserId, includeContactMethod = true) => {
    const profileFetchLambdaInvoke = adminUtil.invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId, includeContactMethod });
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
    logger('User balance result, raw: ', userBalanceResult);
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

/**
 * Function for looking up a user and returning basic data about them
 * @param {object} event An event object containing the request context and query paramaters specifying the search to make
 * @property {object} requestContext As in method above (contains context, from auth, etc)
 * @property {object} queryStringParamaters Contains one of nationalId & country code, phone number, and email address
 */
module.exports.findUsers = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const lookUpPayload = opsCommonUtil.extractQueryParams(event);
        logger('Looking up user, with payload: ', lookUpPayload);

        // simple thing for now, will add much more stuff when we actually have users
        if (lookUpPayload.type && lookUpPayload.type === 'list') {
            const listOfAccounts = await persistence.listAccounts();
            const responseList = listOfAccounts.map((account) => ({ ...account, creationTime: moment(account.creationTime).valueOf() }));
            return adminUtil.wrapHttpResponse(responseList);        
        }

        let systemWideUserId = null;
        
        if (Reflect.has(lookUpPayload, 'bankReference')) {
            logger('Trying to find user from bank reference or account name');
            const candidateUsers = await persistence.findUserFromRef({ searchValue: lookUpPayload.bankReference, bsheetPrefix: config.get('bsheet.prefix') });
            logger('Candidate users: ', candidateUsers);
            
            if (!candidateUsers || candidateUsers.length === 0) {
                return opsCommonUtil.wrapResponse({ result: 'USER_NOT_FOUND' }, status('Not Found'));
            }

            if (candidateUsers.length > 1) {
                const searchResponse = candidateUsers.map((account) => ({ ...account, creationTime: moment(account.creationTime).valueOf() }));
                return adminUtil.wrapHttpResponse(searchResponse);
            }

            systemWideUserId = candidateUsers[0];
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
