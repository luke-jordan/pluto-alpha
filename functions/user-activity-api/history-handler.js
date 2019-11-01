'use strict';

const logger = require('debug')('jupiter:history:main');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const persistence = require('./persistence/rds');
const util = require('./history-util');
const opsCommonUtil = require('ops-util-common');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const fetchUserDefaultAccount = async (systemWideUserId) => {
    logger('Fetching user accounts for user ID: ', systemWideUserId);
    const userAccounts = await persistence.findAccountsForUser(systemWideUserId);
    logger('Retrieved accounts: ', userAccounts);
    return Array.isArray(userAccounts) && userAccounts.length > 0 ? userAccounts[0] : null;
};

const fetchUserProfile = async (systemWideUserId) => {
    const profileFetchLambdaInvoke = util.invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId });
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

    const historyInvocation = util.invokeLambda(config.get('lambdas.userHistory'), userHistoryEvent);
    const historyFetchResult = await lambda.invoke(historyInvocation).promise();
    logger('Result of history fetch: ', historyFetchResult);

    // this one is not wrapped because it is only ever used on direct invocation
    if (historyFetchResult['StatusCode'] !== 200 || JSON.parse(historyFetchResult['Payload']).result !== 'success') {
        logger('ERROR! Something went wrong fetching history');
    }

    return JSON.parse(historyFetchResult['Payload']).userEvents;
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

    const balanceLambdaInvocation = util.invokeLambda(config.get('lambdas.fetchUserBalance'), balancePayload);

    const userBalanceResult = await lambda.invoke(balanceLambdaInvocation).promise();
    return extractLambdaBody(userBalanceResult);
};

/**
 * Fetches user history which includes current balance, current months interest, prior transactions, and past major user events.
 * @param {object} event An event object containing the request context and query paramaters specifying the search to make
 * @property {object} requestContext As in method above (contains context, from auth, etc)
 * @property {object} queryStringParamaters Contains one of nationalId & country code, phone number, and email address
 */
module.exports.fetchUserHistory = async (event) => {
    try {
        if (!util.isUserAuthorized(event)) {
            return util.unauthorizedResponse;
        }

        const lookUpPayload = opsCommonUtil.extractQueryParams(event);
        const lookUpInvoke = util.invokeLambda(config.get('lambdas.systemWideIdLookup'), lookUpPayload);

        logger('Invoking system wide user ID lookup with params: ', lookUpInvoke);
        const systemWideIdResult = await lambda.invoke(lookUpInvoke).promise();
        const systemIdPayload = JSON.parse(systemWideIdResult['Payload']);

        if (systemIdPayload.statusCode !== 200) {
            return opsCommonUtil.wrapResponse({ result: 'USER_NOT_FOUND' }, status('Not Found'));
        }

        const { systemWideUserId } = JSON.parse(systemIdPayload.body);
        logger(`From query params: ${JSON.stringify(lookUpPayload)}, got system ID: ${systemWideUserId}`);

        const [userProfile, priorEvents] = await Promise.all([
            fetchUserProfile(systemWideUserId), obtainUserHistory(systemWideUserId)
        ]);

        const userBalance = await obtainUserBalance(userProfile);
        const accruedInterest = { }; // implement
        const accountId = await fetchUserDefaultAccount(systemWideUserId);
        logger('Got account id:', accountId);

        const priorTransactions = await persistence.fetchPriorTransactions(accountId);
        logger('Got prior transactions:', priorTransactions);

        const userHistory = [...util.normalize(priorEvents.userEvents, 'HISTORY'), ...util.normalize(priorTransactions, 'TRANSACTION')];
        logger('Created formatted array:', userHistory);

        const resultObject = { 
            userBalance,
            accruedInterest, 
            userHistory
        };
        
        logger('Returning: ', resultObject);
        return opsCommonUtil.wrapResponse(resultObject);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};
