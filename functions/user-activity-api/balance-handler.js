'use strict';

const logger = require('debug')('jupiter:balance:main');
const config = require('config');
const status = require('statuses');

const moment = require('moment-timezone');
const BigNumber = require('bignumber.js');

const persistence = require('./persistence/rds');
const dynamodb = require('./persistence/dynamodb');
const opsUtil = require('ops-util-common');

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const ACCOUNT_NOT_FOUND_CODE = 404;

const fetchUserDefaultAccount = async (systemWideUserId) => {
  logger('Fetching user accounts for user ID: ', systemWideUserId);
  const userAccounts = await persistence.findAccountsForUser(systemWideUserId);
  logger('Retrieved accounts: ', userAccounts);
  return Array.isArray(userAccounts) && userAccounts.length > 0 ? userAccounts[0] : null;
};

const accrueBalanceByDay = (currentBalanceAmount, floatProjectionVars) => {
  const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
  const annualAccrualRateNominalGross = new BigNumber(floatProjectionVars.accrualRateAnnualBps).dividedBy(basisPointDivisor);
  // logger('Accrual rate gross: ', annualAccrualRateNominalGross.toNumber());
  const floatDeductions = new BigNumber(floatProjectionVars.bonusPoolShareOfAccrual).plus(floatProjectionVars.clientShareOfAccrual).
    plus(floatProjectionVars.prudentialFactor);
  // logger('Float deductions: ', floatDeductions.toNumber());
  const dailyAccrualRateNominalNet = annualAccrualRateNominalGross.dividedBy(365).times(new BigNumber(1).minus(floatDeductions));
  // logger('Daily accrual net: ', dailyAccrualRateNominalNet.toNumber());
  const endOfDayBalanceAmount = new BigNumber(currentBalanceAmount).times(new BigNumber(1).plus(dailyAccrualRateNominalNet));
  // logger('Balance: ', endOfDayBalanceAmount.toNumber());
  return endOfDayBalanceAmount;
};

const createBalanceDict = (amount, unit, currency, timeMoment) => ({
  amount: amount,
  unit: unit,
  currency: currency,
  datetime: timeMoment.format(),
  epochMilli: timeMoment.valueOf(),
  timezone: timeMoment.tz()
});

const assembleBalanceForUser = async (accountId, currency, timeForBalance, floatProjectionVars, daysToProject) => {
    // in future we might send multiple back, if user has multiple
    const resultObject = { accountId: [accountId] }; 

    // logger('Retrieving balance at time: ', timeForBalance.unix());
    const startingBalance = await persistence.sumAccountBalance(accountId, currency, timeForBalance);
    logger('Starting balance calculated as: ', startingBalance);
    
    const unit = startingBalance.unit;
    
    const lastSettledTime = startingBalance.lastTxTime;
    const startOfTodayTime = timeForBalance.clone().startOf('day');
    const startTime = startOfTodayTime.isBefore(lastSettledTime) ? lastSettledTime : startOfTodayTime;
    logger('Start time in calculations: ', startTime);
    resultObject.balanceStartDayOrLastSettled = createBalanceDict(startingBalance.amount, unit, currency, startTime);

    const endOfDayMoment = timeForBalance.clone().endOf('day');
    const endOfTodayBalance = accrueBalanceByDay(startingBalance.amount, floatProjectionVars);
    logger('Balance at end of today: ', endOfTodayBalance.decimalPlaces(0).toNumber());
    
    resultObject.balanceEndOfToday = createBalanceDict(endOfTodayBalance.decimalPlaces(0).toNumber(), unit, currency, endOfDayMoment);

    const secondsDifference = timeForBalance.unix() - startTime.unix();
    const accruedAmountPerSecond = endOfTodayBalance.minus(startingBalance.amount).dividedBy(endOfDayMoment.unix() - startTime.unix());
    const currentBalanceAmount = new BigNumber(startingBalance.amount).plus(accruedAmountPerSecond.times(secondsDifference));

    resultObject.currentBalance = createBalanceDict(currentBalanceAmount.decimalPlaces(0).toNumber(), unit, currency, timeForBalance);

    if (daysToProject > 0) {
      let currentProjectedBalance = endOfTodayBalance;
      const balanceSubsequentDays = [];
      for (let i = 1; i <= daysToProject; i += 1) {
        currentProjectedBalance = accrueBalanceByDay(currentProjectedBalance, floatProjectionVars);
        const endOfThatDay = endOfDayMoment.clone().add(i, 'days');
        const endOfIthDayDict = createBalanceDict(currentProjectedBalance.decimalPlaces(0).toNumber(), unit, currency, endOfThatDay);
        // logger('Adding end of day dict: ', endOfIthDayDict);
        balanceSubsequentDays.push(endOfIthDayDict);
      }

      resultObject.balanceSubsequentDays = balanceSubsequentDays;
    }

    if (floatProjectionVars.comparatorRates) {
      const referenceRateDeductions = floatProjectionVars.bonusPoolShareOfAccrual + floatProjectionVars.clientShareOfAccrual;
      const referenceRate = Math.floor(floatProjectionVars.accrualRateAnnualBps * (1 - referenceRateDeductions));
      resultObject.comparatorRates = { referenceRate, ...floatProjectionVars.comparatorRates };
    }

    return resultObject;
};

/**
 * This function fetches account balances and projections.
 * @param {object} event An event object containing the request context and request body. Body properties are described below.
 * @property {string} accountId The account id to obtain balance from.
 * @property {string} clientId The client id.
 * @property {string} floatId The float id.
 * @property {string} currency A three digit currency code.
 * @property {string} atEpochMillis The time the call to this function was made.
 * @property {string} timezone The callers timezone.
 */
module.exports.balance = async (event) => {
  try {
    if (!event || typeof event !== 'object' || Object.keys(event).length === 0) {
      logger('No event! Must be warmup lambda, open Dynamo gateway and exit');
      await dynamodb.warmupCall();
      return { statusCode: 400, body: 'Empty invocation' };
    }

    // todo : look up property
    const params = event.queryParams || event;

    if (!params.accountId && !params.userId) {
      return invalidRequestResponse('No account or user ID provided');
    } else if (!params.currency) {
      return { statusCode: 400, body: 'No currency provided for this request' };
    } else if (!params.timezone) {
      return { statusCode: 400, body: 'No timezone provided for user' };
    } else if (!params.atEpochMillis) {
      return { statusCode: 400, body: 'No time for balance calculation provided' };
    }
    
    const accountId = params.accountId || await fetchUserDefaultAccount(params.userId);
    logger('Finding balance for user with accountId: ', accountId);

    if (!accountId) {
      return { statusCode: ACCOUNT_NOT_FOUND_CODE, body: 'User does not have an account open yet' };
    }
    
    let clientId = '';
    let floatId = '';

    if (params.clientId && params.floatId) {
      clientId = params.clientId;
      floatId = params.floatId;              
    } else {
      // note: if these are misaligned the variables will not be found in the dyanmodb and error will be thrown below
      // in other words, a check here might be theoretically needed but would require further dynamo/rds calls and would be somewhat redundant
      const defaultClientAndFloat = await persistence.getOwnerInfoForAccount(accountId);
      logger('Received default client and float: ', defaultClientAndFloat);
      clientId = params.clientId || defaultClientAndFloat.clientId;
      floatId = params.floatId || defaultClientAndFloat.floatId;
    }

    const currency = params.currency;

    // logger(`Fetching config vars for client ${clientId} and float ${floatId}`);
    const floatProjectionVars = await dynamodb.fetchFloatVarsForBalanceCalc(clientId, floatId);
    logger('Retrieved float config vars: ', floatProjectionVars);

    // leaving these in here, just in case we decide to drop the enforcement above
    const timezone = params.timezone || floatProjectionVars.defaultTimezone;
    const providedTime = moment(params.atEpochMillis);
    // const timeForBalance = params.atEpochMillis ? moment.valueOf(params.atEpochMillis).tz(timezone) : moment.tz(timezone);
    const timeForBalance = params.atEpochMillis ? providedTime.tz(timezone) : moment.tz(timezone);
    logger('Time for balance unix: ', timeForBalance.unix());

    // we allow the client to define how many days to project, but put a cap to prevent a malfunctioning client from blowing things up
    const passedDays = Number.isSafeInteger(params.daysToProject) ? params.daysToProject : config.get('projection.defaultDays');
    const daysToProject = Math.min(passedDays, config.get('projection.maxDays'));

    const resultObject = await assembleBalanceForUser(accountId, currency, timeForBalance, floatProjectionVars, daysToProject);
    
    // logger('Sending back result object: ', resultObject);
    return {
      statusCode: 200,
      body: JSON.stringify(resultObject)
    };
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return {
      statusCode: 500,
      body: JSON.stringify(e.message)
    };
  }
};

/**
 * This is a convenience method exposed to allow for simple JWT based get balance based on defaults
 * Here only the account holders system wide id is required as a parameter (which is passed in the events requestContext.authorizer object).
 * @param {object} event An event object containing the request context.
 * @property {object} requestContext An object containing the callers system wide id, role, and permissions. The event will not be processed without a valid request context.
 */
module.exports.balanceWrapper = async (event) => {
  try {
    if (!event || typeof event !== 'object' || Object.keys(event).length === 0) {
      logger('No event! Must be warmup lambda, open Dynamo gateway and exit');
      dynamodb.warmupCall();
      return { statusCode: 400, body: 'Empty invocation' };
    }

    const authParams = event.requestContext.authorizer;
    if (!authParams || !authParams.systemWideUserId) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }

    const systemWideUserId = authParams.systemWideUserId;
    const accountId = await fetchUserDefaultAccount(systemWideUserId);
    const floatAndClient = await persistence.getOwnerInfoForAccount(accountId);
    logger('Received float and client: ', floatAndClient);
    const floatParams = await dynamodb.fetchFloatVarsForBalanceCalc(floatAndClient.clientId, floatAndClient.floatId);
    logger('Received float params: ', floatParams);

    const timezone = floatParams.defaultTimezone;
    const timeForBalance = moment.tz(timezone);
    logger('Timezone: ', timezone, ' and moment: ', timeForBalance.tz());

    const resultObject = await assembleBalanceForUser(accountId, floatParams.currency, timeForBalance, floatParams, config.get('projection.defaultDays'));
    logger('Result object: ', resultObject);

    return opsUtil.wrapResponse(resultObject);
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return {
      statusCode: 500,
      body: JSON.stringify(e.message)
    };
  }
};
