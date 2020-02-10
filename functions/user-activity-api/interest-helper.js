'use strict';

const logger = require('debug')('jupiter:interest-helper');
const dynamodb = require('./persistence/dynamodb');
const moment = require('moment');
const DAYS_IN_A_YEAR = 365;
const opsUtil = require('ops-util-common');
const DecimalLight = require('decimal.js-light');

const calculateInterestRate = async (floatProjectionVars) => {
    logger(`Calculate interest rate for float projection vars: ${JSON.stringify(floatProjectionVars)}`);
    const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
    const annualAccrualRateNominalGross = new DecimalLight(floatProjectionVars.accrualRateAnnualBps).dividedBy(basisPointDivisor);
    const floatDeductions = new DecimalLight(floatProjectionVars.bonusPoolShareOfAccrual).plus(floatProjectionVars.clientShareOfAccrual).
    plus(floatProjectionVars.prudentialFactor);

    const interestRateAsBigNumber = annualAccrualRateNominalGross.times(new DecimalLight(1).minus(floatDeductions));
    logger(`Interest rate as big number: ${interestRateAsBigNumber}`);
    return interestRateAsBigNumber;
};

const calculateCompoundInterestUsingDayInterval = (amount, interestRateAsBigNumber, numberOfDays) => {
    logger(`Calculate compound interest for amount: ${amount} at 
    daily interest rate: ${interestRateAsBigNumber} for total days: ${numberOfDays}`);
    const amountAsBigNumber = new DecimalLight(amount);
    const baseCompoundRate = new DecimalLight(1).plus(interestRateAsBigNumber);

    const baseCompoundRateAfterGivenDays = baseCompoundRate.pow(new DecimalLight(numberOfDays).dividedBy(DAYS_IN_A_YEAR));
    logger('base compound rate after given days', baseCompoundRateAfterGivenDays);

    const compoundInterest = amountAsBigNumber.times(baseCompoundRateAfterGivenDays).minus(amountAsBigNumber);
    logger(`Successfully calculated Compound Interest: ${compoundInterest} for day interval: ${numberOfDays}`);
    return compoundInterest.valueOf();
};

const calculateNumberOfDaysPassedSinceDateAndToday = async (givenDate) => {
    const givenDateFormatted = moment(givenDate, 'YYYY-MM-DD');
    const dateOfToday = moment().startOf('day');
    logger(`Calculate number of days since start of date: ${givenDate} and start of today: ${dateOfToday}`);

    const numberOfDaysPassedSinceDate = moment.duration(dateOfToday.diff(givenDateFormatted)).asDays();
    logger(`Number of days since date: ${givenDate} and today: ${dateOfToday}. Result: ${numberOfDaysPassedSinceDate}`);
    return numberOfDaysPassedSinceDate;
};

module.exports.calculateEstimatedInterestEarned = async (transactionInformation, calculationUnit = 'HUNDREDTH_CENT') => {
    logger(`Calculate estimated interest earned`);
    const floatProjectionVars = await dynamodb.fetchFloatVarsForBalanceCalc(transactionInformation.clientId, transactionInformation.floatId);
    const interestRateAsBigNumber = await calculateInterestRate(floatProjectionVars);
    const numberOfDaysSinceSettleTime = await calculateNumberOfDaysPassedSinceDateAndToday(transactionInformation.settlementTime);
    const amount = Math.abs(opsUtil.convertToUnit(transactionInformation.amount, transactionInformation.unit, calculationUnit));
    const interestEarned = await calculateCompoundInterestUsingDayInterval(amount, interestRateAsBigNumber, numberOfDaysSinceSettleTime);
    return { amount: interestEarned, unit: calculationUnit, currency: transactionInformation.currency };
};
