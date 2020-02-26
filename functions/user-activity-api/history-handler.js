'use strict';

const logger = require('debug')('jupiter:history:main');
const config = require('config');
const moment = require('moment');

const accountCalculator = require('./persistence/account.calculations');
const persistenceRead = require('./persistence/rds.js');
const dynamodb = require('./persistence/dynamodb');

const util = require('./history-util');
const opsUtil = require('ops-util-common');

const interestHelper = require('./interest-helper');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const UNIT_DIVISORS = {
    'HUNDREDTH_CENT': 100 * 100,
    'WHOLE_CENT': 100,
    'WHOLE_CURRENCY': 1 
};

const unauthorizedResponse = { statusCode: 403 };

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const fetchUserDefaultAccount = async (systemWideUserId) => {
    logger('Fetching user accounts for user ID: ', systemWideUserId);
    const userAccounts = await persistenceRead.findAccountsForUser(systemWideUserId);
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
    logger('Obtaining user history');
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

const formatAmountResult = (amountResult) => {
    logger('Formatting amount result: ', amountResult);
    const wholeCurrencyAmount = amountResult.amount / UNIT_DIVISORS[amountResult.unit];

    // JS's i18n for emerging market currencies is lousy, and gives back the 3 digit code instead of symbol, so have to hack for those
    // implement for those countries where client opcos have launched
    if (amountResult.currency === 'ZAR') {
        const emFormat = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
        return `R${emFormat.format(wholeCurrencyAmount)}`;
    }

    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: amountResult.currency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    });
    
    return numberFormat.format(wholeCurrencyAmount);
};

const fetchAccountEarnings = async (systemWideUserId, currency) => {
    const operation = `total_earnings::WHOLE_CENT::${currency}`;
    const amountResult = await accountCalculator.getUserAccountFigure({ systemWideUserId, operation });
    logger('Retrieved earnings from persistence: ', amountResult);
    return formatAmountResult(amountResult);
};

const fetchNetSavings = async (systemWideUserId, currency) => {
    const operation = `net_saving::WHOLE_CENT::${currency}`;
    const amountResult = await accountCalculator.getUserAccountFigure({ systemWideUserId, operation });
    logger('Retrieved savings from persistence: ', amountResult);
    return formatAmountResult(amountResult);
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

    logger('Balance payload: ', balancePayload);
    const balanceLambdaInvocation = util.invokeLambda(config.get('lambdas.fetchUserBalance'), balancePayload);

    const userBalanceResult = await lambda.invoke(balanceLambdaInvocation).promise();
    return extractLambdaBody(userBalanceResult);
};

const normalizeHistory = (events) => {
    const result = [];
    events.forEach((event) => {
        result.push({
            timestamp: event.timestamp,
            type: 'HISTORY',
            details: {
                initiator: event.initiator,
                context: event.context,
                interface: event.interface,
                eventType: event.eventType
            }
        });
    });
    return result;
};

const constructUniqueClientFloatsMap = (events) => {
    const allClientFloatIds = events.
        filter((event) => event.transactionType === 'USER_SAVING_EVENT').
        map((event) => `${event.clientId}::${event.floatId}`);
    return [...new Set(allClientFloatIds)];
};

const obtainClientFloatVars = async (clientFloatPair) => {
    const [clientId, floatId] = clientFloatPair.split('::');
    const floatProjectionVars = await dynamodb.fetchFloatVarsForBalanceCalc(clientId, floatId);
    const interestRate = interestHelper.calculateInterestRate(floatProjectionVars);
    return { clientFloatPair, interestRate };
};

const constructClientFloatsToInterestRatesMap = async (events) => {
    const uniqueClientFloatPairs = constructUniqueClientFloatsMap(events);
    const interestArray = await Promise.all(uniqueClientFloatPairs.map((clientFloatPair) => obtainClientFloatVars(clientFloatPair)));
    return interestArray.reduce((map, entry) => ({ ...map, [entry.clientFloatPair]: entry.interestRate}), {});
};

const formatTx = (event) => ({
    timestamp: moment(event.creationTime).valueOf(),
    type: 'TRANSACTION',
    details: {
        transactionId: event.transactionId,
        accountId: event.accountId,
        transactionType: event.transactionType,
        settlementStatus: event.settlementStatus,
        amount: event.amount,
        currency: event.currency,
        unit: event.unit,
        humanReference: event.humanReference
    }
});

const normalizeTx = async (events) => {
    logger('Normalizing transactions');
    const clientFloatsToInterestRatesMap = await constructClientFloatsToInterestRatesMap(events);
    const normalizedTransactions = events.map((event) => {
        
        const normalizedTx = formatTx(event);
        if (event.transactionType === 'USER_SAVING_EVENT') {
            const thisInterestRate = clientFloatsToInterestRatesMap[`${event.clientId}::${event.floatId}`];
            normalizedTx.estimatedInterestEarned = interestHelper.calculateEstimatedInterestEarned(event, 'HUNDREDTH_CENT', thisInterestRate); 
        }

        return normalizedTx;
    });

    logger(`Completed normalizing transactions. Sample result: ${JSON.stringify(normalizedTransactions.length > 0 ? normalizedTransactions[0] : {})}`);
    return normalizedTransactions;
};

/**
 * Fetches user history which includes current balance, current months interest, prior transactions, and past major user events.
 * @param {object} event An event object containing the request context and query paramaters specifying the search to make
 * @property {object} requestContext As in method above (contains context, from auth, etc)
 */
module.exports.fetchUserHistory = async (event) => {
    try {
        if (!event || typeof event !== 'object' || Object.keys(event).length === 0) {
            return { statusCode: 400, body: 'Empty invocation' };
        }

        if (!util.isUserAuthorized(event)) {
            return unauthorizedResponse;
        }

        // extract user details will only come back null if authorized check has failed
        const { systemWideUserId } = opsUtil.extractUserDetails(event);
        logger(`Looking up system ID: ${systemWideUserId}`);

        const [userProfile, priorEvents] = await Promise.all([
            fetchUserProfile(systemWideUserId), obtainUserHistory(systemWideUserId)
        ]);
        
        const currency = userProfile.defaultCurrency;
        const [userBalance, totalEarnings, netSavings] = await Promise.all([
            obtainUserBalance(userProfile), fetchAccountEarnings(systemWideUserId, currency), fetchNetSavings(systemWideUserId, currency)
        ]);

        const accountId = await fetchUserDefaultAccount(systemWideUserId);
        logger('Got account id:', accountId);
        const [priorTransactions, pendingTransactions] = await Promise.all([
            persistenceRead.fetchTransactionsForHistory(accountId),
            persistenceRead.fetchPendingTransactions(accountId)
        ]);

        logger(`Got ${priorTransactions.length} prior transactions, sample: ${JSON.stringify(priorTransactions)}`);
        logger(`Got ${pendingTransactions.length} pending transactions too`);

        const normalizedTransactions = await normalizeTx(priorTransactions);
        const userHistory = [...normalizeHistory(priorEvents.userEvents), ...normalizedTransactions];
        logger(`Created formatted array of length ${userHistory.length} and sample: ${JSON.stringify(userHistory[0])}`);

        const userPending = pendingTransactions.map((tx) => formatTx(tx));
        logger('And formatted pending transactions: ', userPending);

        const resultObject = {
            userBalance,
            accruedInterest: totalEarnings, // legacy to avoid mobile crashes, remove soon
            totalEarnings,
            netSavings,
            userHistory,
            userPending
        };
        
        logger('Returning: ', resultObject);
        return opsUtil.wrapResponse(resultObject);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsUtil.wrapResponse(err.message, 500);
    }
};

module.exports.calculateUserAmount = async (event) => {
    if (opsUtil.isApiCall(event)) {
        return unauthorizedResponse;
    }

    logger('Processing user history direct invocation, event: ', event);
    const { aggregates, systemWideUserId } = event;

    const opsPromises = aggregates.map((aggregate) => accountCalculator.getUserAccountFigure({ systemWideUserId, operation: aggregate }));
    const resultsOfOperations = await Promise.all(opsPromises);
    
    logger('Result: ', resultsOfOperations);

    return { results: resultsOfOperations };
};
