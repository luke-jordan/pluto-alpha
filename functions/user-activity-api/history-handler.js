'use strict';

const logger = require('debug')('jupiter:history:main');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds');
const util = require('./history-util');
const opsCommonUtil = require('ops-util-common');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const UNIT_DIVISORS = {
    'HUNDREDTH_CENT': 100 * 100,
    'WHOLE_CENT': 100,
    'WHOLE_CURRENCY': 1 
};

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

const fetchAccountInterest = async (systemWideUserId, currency, sinceTimeMillis) => {
    const operation = `interest::WHOLE_CENT::${currency}::${sinceTimeMillis}`;
    const amountResult = await persistence.getUserAccountFigure({ systemWideUserId, operation });
    logger('Retrieved from persistence: ', amountResult);
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

const normalizeTx = (events) => {
    const result = [];
    events.forEach((event) => {
        result.push({
            timestamp: moment(event.creationTime).valueOf(),
            type: 'TRANSACTION',
            details: {
                accountId: event.accountId,
                transactionType: event.transactionType,
                settlementStatus: event.settlementStatus,
                amount: event.amount,
                currency: event.currency,
                unit: event.unit,
                humanReference: event.humanReference
            }
        });
    });
    return result;
};

/**
 * Fetches user history which includes current balance, current months interest, prior transactions, and past major user events.
 * @param {object} event An event object containing the request context and query paramaters specifying the search to make
 * @property {object} requestContext As in method above (contains context, from auth, etc)
 */
module.exports.fetchUserHistory = async (event) => {
    try {
        if (!util.isUserAuthorized(event)) {
            return util.unauthorizedResponse;
        }

        // extract user details will only come back null if authorized check has failed
        const { systemWideUserId } = opsCommonUtil.extractUserDetails(event);
        logger(`Looking up system ID: ${systemWideUserId}`);

        const [userProfile, priorEvents] = await Promise.all([
            fetchUserProfile(systemWideUserId), obtainUserHistory(systemWideUserId)
        ]);

        const userBalance = await obtainUserBalance(userProfile);
        const accruedInterest = await fetchAccountInterest(systemWideUserId, userProfile.defaultCurrency, moment().startOf('month').valueOf());

        const accountId = await fetchUserDefaultAccount(systemWideUserId);
        logger('Got account id:', accountId);
        const priorTransactions = await persistence.fetchPriorTransactions(accountId);
        logger('Got prior transactions:', priorTransactions);

        const userHistory = [...normalizeHistory(priorEvents.userEvents), ...normalizeTx(priorTransactions)];
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
