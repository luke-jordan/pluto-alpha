'use strict';

const chai = require('chai');
const sinon = require('sinon');
const uuid = require('uuid');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');
const fetchFloatVarsForBalanceCalcStub = sinon.stub();

const handler = proxyquire('../interest-helper', {
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsForBalanceCalcStub,
        '@noCallThru': true
    }
});

describe('*** Unit Test Admin User Handler ***', () => {
    const testClientId = uuid();
    const testFloatId = uuid();
    const testSettlementTime = '2020-01-01';

    beforeEach(() => fetchFloatVarsForBalanceCalcStub.reset());

    it('Interest handler calculates interest successfully', async () => {
        const testCalculationUnit = 'HUNDREDTH_CENT';
        const testCurrency = 'ZAR';
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

        const testCompoundInterest = '18.8485978005249';

        const expectedResult = {
            amount: testCompoundInterest,
            unit: testCalculationUnit,
            currency: testCurrency
        };

        const response = await handler.calculateEstimatedInterestEarned(testTransactionInformation, testCalculationUnit);

        expect(response).to.exist;
        expect(response).to.deep.equal(expectedResult);
        expect(fetchFloatVarsForBalanceCalcStub).to.have.been.calledOnce;
    });
});
