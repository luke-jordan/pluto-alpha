'use strict';

const logger = require('debug')('jupiter:interest:test');
const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
const uuid = require('uuid');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const DecimalLight = require('decimal.js-light');
const fetchFloatVarsForBalanceCalcStub = sinon.stub();

const DAYS_IN_A_YEAR = 365;

const handler = require('../interest-helper');

describe('*** Unit Test Admin User Handler ***', () => {
    const testClientId = uuid();
    const testFloatId = uuid();

    beforeEach(() => fetchFloatVarsForBalanceCalcStub.reset());

    it('Interest handler calculates interest successfully', async () => {
        const testCalculationUnit = 'HUNDREDTH_CENT';
        const testCurrency = 'ZAR';

        const testSettlementTime = moment().subtract(5, 'days');

        const testTransactionInformation = {
            clientId: testClientId,
            floatId: testFloatId,
            settlementTime: testSettlementTime,
            amount: 10000,
            unit: testCalculationUnit,
            currency: testCurrency
        };

        const testNumberOfDaysPassedSinceDate = 5;
        const testInterestRate = 0.01875;

        const testAmountAsD = new DecimalLight(testTransactionInformation.amount);
        const testCompoundRate = new DecimalLight(1 + testInterestRate).
            pow(new DecimalLight(testNumberOfDaysPassedSinceDate).dividedBy(DAYS_IN_A_YEAR));
        
        logger('Compounded rate: ', testCompoundRate.valueOf());
        const testCompoundInterest = testAmountAsD.times(testCompoundRate).minus(testAmountAsD).toNumber();
        logger('Should be: ', testCompoundInterest);

        const expectedResult = {
            amount: testCompoundInterest,
            unit: testCalculationUnit,
            currency: testCurrency
        };

        const response = handler.calculateEstimatedInterestEarned(testTransactionInformation, testCalculationUnit, testInterestRate);

        expect(response).to.exist;
        expect(response).to.deep.equal(expectedResult);
    });
});
