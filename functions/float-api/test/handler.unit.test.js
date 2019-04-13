process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');
const BigNumber = require('bignumber.js');

const chai = require('chai');
const expect = chai.expect;

const handler = require('../handler');
const common = require('./common');

describe('Single apportionment operations', () => {

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
        expect(handler.calculateShare.bind(handler, pool, badShare2)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, pool, badShare3)).to.throw(RangeError);
    });

});

describe('Multiple apportionment operations', () => {

    it.only('Divide up the float with well-formed inputs', () => {
        const amountToAportion = Math.floor(Math.random() * 1e6); // somewhere in the region of R100
        logger('Apportioning (in ZAR): ', amountToAportion / 1e4);
        const numberOfAccounts = 10;
        const numberList = Array.from(Array(numberOfAccounts).keys());
        
        const testAccountDict = { };
        // generate set of numbers representing accounts with ~R10k each
        const accountValues = numberList.map(_ => Math.floor(Math.random() * 1e9));
        numberList.forEach(n => testAccountDict['test-account-' + n] = accountValues[n]);
        const sumOfAccounts = accountValues.reduce((a, b) => a + b, 0);

        // logger(`Generated account shares: ${JSON.stringify(testAccountDict)}`);
        logger(`Sum of values (in ZAR): ${sumOfAccounts / 1e4}, and list: ${accountValues}`);
        
        const accountShares = accountValues.map(value => (value * 10) / (sumOfAccounts * 10)); // note: FP may result in _above_ 100% (!)
        const sumOfPercent = accountShares.reduce((a, b) => a + b, 0);
        logger(`Percentage splits amount accounts: ${accountShares}, sums to: ${sumOfPercent}`);
        
        const dividedUpAmounts = accountShares.map(share => Math.floor(share * amountToAportion));
        const sumCheck = dividedUpAmounts.reduce((a, b) => a + b, 0);
        logger(`Divided up amounts: ${dividedUpAmounts}, which sums to: ${sumCheck}, vs original: ${amountToAportion}`);

        const resultOfApportionment = handler.apportion(amountToAportion, testAccountDict);

        expect(resultOfApportionment).to.exist;
        expect(resultOfApportionment).to.eql(dividedUpAmounts);
    });

});