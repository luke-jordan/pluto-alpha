'use strict';

const logger = require('debug')('pluto:save:main');
const config = require('config');

const moment = require('moment-timezone');
const BigNumber = require('bignumber.js');

const persistence = require('./persistence/rds');
const dynamodb = require('./persistence/dynamodb');

module.exports.save = async (event) => {
  try {
    logger('Initiating transaction record to save, environment: ', process.env.NODE_ENV);

    logger('Here is our event: ', event);
    const settlementInformation = event['body'] ? JSON.parse(event['body']) : event;
    logger('Have a saving request inbound: ', settlementInformation);

    // todo : check validity

    const savingResult = await exports.storeSettledSaving(settlementInformation);
    logger('Completed the save, result: ', savingResult);

    return {
      statusCode: 200,
      body: JSON.stringify(savingResult)
    };
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return {
      statusCode: 500
    };
  }
};

module.exports.storeSettledSaving = async (settlementInformation = {
  'accountId': '0c3caa51-ce5f-467c-9470-3fc34f93b5cc',
  'initiationTime': Date.now(),
  'settlementTime': Date.now(),
  'savedAmount': 50000, // five rand (figures always in hundredths of a cent)
  'savedCurrency': 'ZAR',
  'prizePoints': 100,
  'offerId': 'id-of-preceding-offer',
  'tags': ['TIME_BASED'],
  'flags': ['RESTRICTED']
}) => {
  
  logger('Initiating settlement record');

  const resultOfSave = await persistence.addSavingToTransactions(settlementInformation);
  logger('Result of save: ', resultOfSave);

  return resultOfSave;
  
};

const fetchUserDefaultAccount = async (systemWideUserId) => {
  const userAccounts = persistence.findAccountsForUser(systemWideUserId);
  return !!userAccounts ? userAccounts[0] : null;
};

const accrueBalanceByDay = (currentBalanceAmount, floatProjectionVars) => {
  const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
  const annualAccrualRateNominalGross = new BigNumber(floatProjectionVars.accrualRateAnnualBps).dividedBy(basisPointDivisor);
  const floatDeductions = new BigNumber(floatProjectionVars.bonusPoolShare).plus(floatProjectionVars.clientCoShare)
    .plus(floatProjectionVars.prudentialFactor);
  const dailyAccrualRateNominalNet = annualAccrualRateNominalGross.dividedBy(365).times(new BigNumber(1).minus(floatDeductions));
  const endOfDayBalanceAmount = new BigNumber(currentBalanceAmount).times(new BigNumber(1).plus(dailyAccrualRateNominalNet));
  return endOfDayBalanceAmount.decimalPlaces(0).toNumber();
};

const createBalanceDict = async (amount, unit, currency, timeMoment) => ({
  amount: amount,
  unit: unit,
  currency: currency,
  datetime: timeMoment.format(),
  epochMilli: timeMoment.valueOf(),
  timezone: timeMoment.tz()
});

module.exports.balance = async (event, context) => {
  if (context) {
    logger('Context object: ', context); // todo : check user role etc
  }

  // todo : look up property
  const params = event.queryParams || event;
  const accountId = params.accountId || fetchUserDefaultAccount(params.userId);

  const clientId = params.clientId;
  const floatId = params.floatId;
  const currency = params.currency;

  const floatProjectionVars = await dynamodb.fetchFloatVarsForBalanceCalc(clientId, floatId);

  const timezone = params.timezone || floatProjectionVars.defaultTimezone;
  const timeForBalance = moment.tz(timezone);

  const resultObject = {};

  logger('Retrieving at time for balance: ', timeForBalance.unix());
 
  const currentBalance = await persistence.sumAccountBalance(accountId, currency, timeForBalance);
  const unit = currentBalance.unit;
  
  logger('Current balance calculated as: ', currentBalance);
  resultObject.currentBalance = createBalanceDict(currentBalance.amount, unit, currency, timeForBalance);
  
  const endOfDayMoment = timeForBalance.clone().endOf('day');
  const endOfTodayBalance = accrueBalanceByDay(currentBalance.amount, floatProjectionVars);
  logger('Balance at end of today: ', endOfTodayBalance);
  resultObject.balanceEndOfToday = createBalanceDict(endOfTodayBalance, unit, currency, endOfDayMoment);

  // we allow the client to define how many days to project, but put a cap to prevent a malfunctioning client from blowing things up
  const maxNumberDaysProjection = Math.min(params.daysToProject || config.get('projection.defaultDays'), config.get('projection.maxDays'));
  
  let currentProjectedBalance = endOfTodayBalance;
  const balanceSubsequentDays = [];
  for (let i = 1; i <= maxNumberDaysProjection; i++) {
    currentProjectedBalance = accrueBalanceByDay(currentProjectedBalance, floatProjectionVars);
    const endOfThatDay = endOfDayMoment.clone().add(i, 'days');
    const endOfIthDayDict = createBalanceDict(currentProjectedBalance, unit, currency, endOfThatDay);
    logger('Adding end of day dict: ', endOfIthDayDict);
    balanceSubsequentDays.push(endOfIthDayDict);
  };

  return resultObject;
};
