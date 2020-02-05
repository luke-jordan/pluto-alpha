'use strict';

const logger = require('debug')('jupiter:interest-helper');
const BigNumber = require('bignumber.js');
const dynamodb = require('./persistence/dynamodb');
const moment = require('moment');
const DAYS_IN_A_YEAR = 365;
const config = require('config');
const opsUtil = require('ops-util-common');

const Redis = require('ioredis');
const redis = new Redis({ port: config.get('cache.port'), host: config.get('cache.host') });
const CACHE_TTL_IN_SECONDS = 3600;

const calculateInterestRate = async (floatProjectionVars) => {
    logger(`Calculate interest rate for float projection vars: ${JSON.stringify(floatProjectionVars)}`);
    const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
    const annualAccrualRateNominalGross = new BigNumber(floatProjectionVars.accrualRateAnnualBps).dividedBy(basisPointDivisor);
    const floatDeductions = new BigNumber(floatProjectionVars.bonusPoolShareOfAccrual).plus(floatProjectionVars.clientShareOfAccrual).
    plus(floatProjectionVars.prudentialFactor);

    const interestRateAsBigNumber = annualAccrualRateNominalGross.times(new BigNumber(1).minus(floatDeductions));
    logger(`Interest rate as big number: ${interestRateAsBigNumber}`);
    return interestRateAsBigNumber;
};

const calculateCompoundInterestUsingDayInterval = (amount, interestRateAsBigNumber, numberOfDays) => {
    logger(`Calculate compound interest for amount: ${amount} at 
    daily interest rate: ${interestRateAsBigNumber} for total days: ${numberOfDays}`);
    const amountAsBigNumber = new BigNumber(amount);
    const baseCompoundRate = new BigNumber(1).plus(interestRateAsBigNumber);
    const baseCompoundRateAfterGivenDays = baseCompoundRate.exponentiatedBy(new BigNumber(numberOfDays).dividedBy(DAYS_IN_A_YEAR));

    const compoundInterest = amountAsBigNumber.times(baseCompoundRateAfterGivenDays).minus(amountAsBigNumber);
    logger(`Successfully calculated Compound Interest: ${compoundInterest} for day interval: ${numberOfDays}`);
    return compoundInterest.integerValue().toNumber();
};

const calculateNumberOfDaysPassedSinceDateAndToday = async (givenDate) => {
    const givenDateFormatted = moment(givenDate, 'YYYY-MM-DD');
    const dateOfToday = moment().startOf('day');
    logger(`Calculate number of days since start of date: ${givenDate} and start of today: ${dateOfToday}`);

    const numberOfDaysPassedSinceDate = moment.duration(dateOfToday.diff(givenDateFormatted)).asDays();
    logger(`Number of days since date: ${givenDate} and today: ${dateOfToday}. Result: ${numberOfDaysPassedSinceDate}`);
    return numberOfDaysPassedSinceDate;
};

const fetchFloatVarsForBalanceCalcFromCacheOrDB = async (transactionInformation) => {
  logger(`Fetching float vars for balance calc from cache or database with transaction information: 
  ${JSON.stringify(transactionInformation)}`);
  try {
      const clientId = transactionInformation.clientId;
      const floatId = transactionInformation.floatId;
      const cacheKeyForFloatVars = `${clientId}_${floatId}`;

      logger(`Fetching float vars for balance calc from cache`);
      const responseFromCache = await redis.get(cacheKeyForFloatVars);
      if (!responseFromCache) {
          logger(`'float vars for balance calc' NOT found in cache`);
          logger(`Fetch 'float vars for balance calc' from database`);
          const responseFromDB = await dynamodb.fetchFloatVarsForBalanceCalc(clientId, floatId);
          await redis.set(cacheKeyForFloatVars, JSON.stringify(responseFromDB), 'EX', CACHE_TTL_IN_SECONDS);
          logger(`Successfully fetched 'float vars for balance calc' from database and stored in cache`);
          return responseFromDB;
      }

      logger(`Successfully fetched 'float vars for balance calc' from cache`);
      return responseFromCache;
  } catch (error) {
      logger(`Error occurred while fetching float vars for balance calc from cache or database with transaction information: 
  ${JSON.stringify(transactionInformation)}. Error: ${error.message}`);
  }
};

module.exports.calculateEstimatedInterestEarned = async (transactionInformation, calculationUnit = 'HUNDREDTH_CENT') => {
    logger(`Calculate estimated interest earned`);
    const floatProjectionVars = await fetchFloatVarsForBalanceCalcFromCacheOrDB(transactionInformation);
    const interestRateAsBigNumber = await calculateInterestRate(floatProjectionVars);
    const numberOfDaysSinceSettleTime = await calculateNumberOfDaysPassedSinceDateAndToday(transactionInformation.settlementTime);
    const amount = Math.abs(opsUtil.convertToUnit(transactionInformation.amount, transactionInformation.unit, calculationUnit));
    const interestEarned = await calculateCompoundInterestUsingDayInterval(amount, interestRateAsBigNumber, numberOfDaysSinceSettleTime);
    return { amount: interestEarned, unit: calculationUnit, currency: transactionInformation.currency };
};
