process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');

const _ = require('lodash');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

const BigNumber = require('bignumber.js');

// setting up the stubbing, for the dynamo and the postgres dependencies
// using rather nice patterns from here: https://gist.github.com/StephaneTrebel/0c90fc435b6d93f297f52c72b3fddfb6
const forceStub = fnName => () => {
    throw new Error('Please stub this: ', fnName);
}

const rdsPath = './persistence/rds';
const dynamoPath = './persistence/dynamodb';

const createStubs = customStubs => _.defaults({}, customStubs, {
    [rdsPath]: { },
    [dynamoPath]: { }
});

const common = require('./common');
const rds = require('../persistence/rds');
const dynamo = require('../persistence/dynamodb');
const constants = require('../constants');

describe('Single apportionment operations', () => {

    const handler = require('../handler');

    it('Calculate bonus share properly, with random values, plus bonus share', () => {
        // note: e13 = 1 * 10^13 = 1 billion rand (1e9) in hundredths of cents
        const poolExamples = Array.from({length: 10}, () => Math.floor(Math.random() * 1e13));
        const shareExamples = Array.from({length: 3}, () => Math.random());
        shareExamples.push(common.testValueBonusPoolShare);
        shareExamples.push(common.testValueCompanyShare);

        poolExamples.forEach(pool => {
            shareExamples.forEach(share => {
                const expectedResult = BigNumber(pool).times(BigNumber(share)).integerValue(BigNumber.ROUND_HALF_UP).toNumber();
                const obtainedResult = handler.calculateShare(pool, share);
                expect(obtainedResult).to.exist;
                expect(obtainedResult).to.be.a('number');
                expect(obtainedResult).to.equal(expectedResult);
            })
        });
    });

    it('Throw an error if passed a bad pool value', () => {
        const badPool1 = 'some_pool_in_numbers!';
        const badPool2 = '1234';
        const badPool3 = 1234.5;

        const share = common.testValueBonusPoolShare;

        expect(handler.calculateShare.bind(handler, badPool1, share)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, badPool2, share)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, badPool3, share)).to.throw(TypeError);
    });

    it('Throw an error if passed a bad share', () => {
        const badShare1 = 'some_share_wrong';
        const badShare2 = 2.5;
        const badShare3 = -1;

        const pool = Math.floor(Math.random() * 1e11);

        expect(handler.calculateShare.bind(handler, pool, badShare1)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, pool, badShare2)).to.throw(RangeError);
        expect(handler.calculateShare.bind(handler, pool, badShare3)).to.throw(RangeError);
    });

});

describe('Multiple apportionment operations', () => {

    const handler = require('../handler');

    it('Divide up the float with well-formed inputs', () => {
        const amountToAportion = Math.floor(Math.random() * 1e9); // somewhere in the region of R100
        
        const numberOfAccounts = 100000; // note this takes 162ms for 10k, and seems to scale linearly, so 1.3secs for 100k. 
        const numberList = Array.from(Array(numberOfAccounts).keys());
        
        const testAccountDict = { };
        // generate set of numbers representing accounts with ~R10k each
        const accountValues = numberList.map(_ => Math.floor(Math.random() * 1e9));
        numberList.forEach((n) => testAccountDict['test-account-' + n] = accountValues[n]);
        const sumOfAccounts = accountValues.reduce((a, b) => a + b, 0);

        // logger(`Generated account shares: ${JSON.stringify(testAccountDict)}`);
        logger(`Sum of values (in ZAR): ${sumOfAccounts / 1e4}, vs amount to apportion: ${amountToAportion / 1e4}`);
        
        const accountShares = accountValues.map(value => (value * 10) / (sumOfAccounts * 10)); // note: FP may result in _above_ 100% (!)
        const sumOfPercent = accountShares.reduce((a, b) => a + b, 0);
        logger(`Percentage splits amount accounts sums to: ${sumOfPercent}`);
        
        const dividedUpAmounts = accountShares.map((share) => Math.round(share * amountToAportion));
        const sumCheck = dividedUpAmounts.reduce((a, b) => a + b, 0);
        const excess = amountToAportion - sumCheck; // this gets bigger as we have more accounts, though at rate of 2.85c in ~5 billion 
        logger(`Divided up amounts sum to: ${sumCheck}, vs original: ${amountToAportion}, excess: ${excess}`);
        
        const resultDict = { };
        numberList.forEach(n => resultDict['test-account-' + n] = dividedUpAmounts[n]);
        if (excess != 0) 
            resultDict['excess'] = excess;

        const resultOfApportionment = handler.apportion(amountToAportion, testAccountDict);

        expect(resultOfApportionment).to.exist;
        expect(resultOfApportionment).to.eql(resultDict);
    });

    it('Check that error is thrown if passed non-integer account balances', () => {
        const amountToAportion = Math.floor(Math.random() * 1e6);
        const accountDict = { 'test-account-1': 234.5 };

        expect(handler.apportion.bind(handler, amountToAportion, accountDict)).to.throw(TypeError);
    })

});

describe('Primary allocation lambda', () => {

    var handler;
    var fetchBonusShareStub;
    var fetchCompanyShareStub;

    var adjustFloatBalanceStub;
    var allocateFloatBalanceStub;

    before(() => {
        fetchBonusShareStub = sinon.stub(dynamo, 'fetchBonusPoolShareOfAccrual').returns(common.testValueBonusPoolShare);
        fetchCompanyShareOfAccrual = sinon.stub(dynamo, 'fetchCompanyShareOfAccrual').returns(common.testValueCompanyShare);

        adjustFloatBalanceStub = sinon.spy(rds, 'addOrSubtractFloat');
        allocateFloatBalanceStub = sinon.spy(rds, 'allocateFloat');
        
        handler = proxyquire('../handler', createStubs({
            [dynamoPath]: { 
                fetchBonusPoolShareOfAccrual: fetchBonusShareStub,
                fetchCompanyShareOfAccrual: fetchCompanyShareStub 
            },
            [rdsPath]: { 
                addOrSubtractFloat: adjustFloatBalanceStub,
                allocateFloat: allocateFloatBalanceStub
            }
        }));
    });

    after(() => {
        dynamo.fetchBonusPoolShareOfAccrual.restore();
        dynamo.fetchCompanyShareOfAccrual.restore();
        rds.addOrSubtractFloat.restore();
        rds.allocateFloat.restore();
    });

    it('Check initial accrual', async () => {
        const amountAccrued = Math.floor(Math.random() * 1e4 * 1e4);  // thousands of rand, in hundredths of a cent

        const accrualEvent = {
            clientId: 'za_savings_co',
            floatId: 'primary_cash_float',
            amountAccrued: amountAccrued,
            currency: 'ZAR',
            unit: constants.floatUnits.HUNDREDTH_CENT
        }

        const response = await handler.accrue(accrualEvent, { });

        expect(fetchBonusShareStub).to.have.been.calledOnce;
        expect(fetchCompanyShareOfAccrual).to.have.been.calledOnce;

        const expectedFloatAdjustment = JSON.parse(JSON.stringify(accrualEvent));
        delete expectedFloatAdjustment['amountAccrued'];
        expectedFloatAdjustment['amount'] = amountAccrued;
        expect(addOrSubtractFloat).to.have.been.calledOnce;
        expect(addOrSubtractFloat).to.have.been.calledWith(expectedFloatAdjustment);

        const expectedBonusAllocation = JSON.parse(JSON.stringify(expectedFloatAdjustment));
        expectedBonusAllocation['amount'] = amountAccrued * common.testValueBonusPoolShare;
        expectedBonusAllocation['allocatedTo'] = common.testValueBonusPoolTracker;

        const expectedClientCoAllocation = JSON.parse(JSON.stringify(expectedBonusAllocation));
        expectedClientCoAllocation['amount'] = amountAccrued * common.testValueCompanyShare;
        expectedClientCoAllocation['allocatedTo'] = common.testValueClientCompanyTracker;

        expect(allocateFloatBalanceStub).to.have.been.calledTwice;
        expect(allocateFloatBalanceStub).to.have.been.calledWith(expectedBonusAllocation);
        expect(allocateFloatBalanceStub).to.have.been.calledWith(expectedClientCoAllocation);

        expect(response.statusCode).to.equal(200);
        expect(response.entity).to.exist;

        expect(response.companyShare).to.exist;
        const companyShare = response.entity.company_share;
        expect(companyShare).to.be.lessThan(amountAccrued);

        expect(response.entity.float_total).to.be.greaterThan(amountAccrued - companyShare);
        expect(response.entity.bonus_pool).to.be.lessThan(amountAccrued - companyShare);

        expect(response.entity.recon_job_id).to.exist;

    })

});