'use strict';

const logger = require('debug')('jupiter:interest-helper.unit.test');
const chai = require('chai');
const sinon = require('sinon');
const uuid = require('uuid');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const moment = require('moment');
const DecimalLight = require('decimal.js-light');
const proxyquire = require('proxyquire');
const fetchFloatVarsForBalanceCalcStub = sinon.stub();
const DAYS_IN_A_YEAR = 365;

const handler = proxyquire('../interest-helper', {
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsForBalanceCalcStub,
        '@noCallThru': true
    }
});

describe('*** Unit Test Admin User Handler ***', () => {
    const testClientId = uuid();
    const testFloatId = uuid();

    beforeEach(() => fetchFloatVarsForBalanceCalcStub.reset());

    it('Interest handler calculates interest successfully', async () => {
        const testCalculationUnit = 'HUNDREDTH_CENT';
        const testCurrency = 'ZAR';
        const testSettlementTime = moment(new Date()).add(-5, 'days').startOf('day');

        const testTransactionInformation = {
            clientId: testClientId,
            floatId: testFloatId,
            settlementTime: testSettlementTime,
            amount: 10000,
            unit: testCalculationUnit,
            currency: testCurrency
        };
        const testAccrualRateBps = 250;
        const testBonusPoolShare = 0.1; // percent of an accrual (not bps)
        const testClientCoShare = 0.05; // as above
        const testPrudentialDiscountFactor = 0.1; // percent, how much to reduce projected increment by

        fetchFloatVarsForBalanceCalcStub.withArgs(testClientId, testFloatId).resolves({
            accrualRateAnnualBps: testAccrualRateBps,
            bonusPoolShareOfAccrual: testBonusPoolShare,
            clientShareOfAccrual: testClientCoShare,
            prudentialFactor: testPrudentialDiscountFactor
        });

        const testNumberOfDaysPassedSinceDate = 5;
        const testInterestRate = 0.01875;
        const testAmountAsBigNumber = new DecimalLight(testTransactionInformation.amount);
        const testBaseCompoundRate = new DecimalLight(1).plus(testInterestRate);
        const testBaseCompoundRateAfterGivenDays = testBaseCompoundRate.pow(new DecimalLight(testNumberOfDaysPassedSinceDate).dividedBy(DAYS_IN_A_YEAR));
        const testCompoundInterest = new DecimalLight(testAmountAsBigNumber.times(testBaseCompoundRateAfterGivenDays).minus(testAmountAsBigNumber).valueOf()).toNumber();

        const expectedResult = {
            amount: testCompoundInterest,
            unit: testCalculationUnit,
            currency: testCurrency
        };

        const response = await handler.calculateEstimatedInterestEarned(testTransactionInformation, testCalculationUnit);
        logger('second attempt =========>'); // this helps test the presence of a client/float in the local map of client/float to interest-rates
        await handler.calculateEstimatedInterestEarned(testTransactionInformation, testCalculationUnit);

        expect(response).to.exist;
        expect(response).to.deep.equal(expectedResult);
        expect(fetchFloatVarsForBalanceCalcStub).to.have.been.calledOnce;
    });
});
