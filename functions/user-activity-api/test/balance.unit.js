'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:balance:test');
const BigNumber = require('bignumber.js');
const moment = require('moment-timezone');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const testAccountId = uuid();
const testUserId = uuid();

// note : in future at some time will need to handle user in different time zone to float
const testTimeZone = 'America/New_York';
const testTimeNow = moment.tz(testTimeZone);
const testTimeEOD = testTimeNow.endOf('day');

const testClientId = 'a_client_somewhere';
const testFloatId = 'usd_cash_primary';

const testAccrualRateBps = 250;
const testBonusPoolShare = 0.1; // percent of an accrual (not bps)
const testClientCoShare = 0.05; // as above
const testPrudentialDiscountFactor = 0.1; // percent, how much to reduce projected increment by

const divisorForAccrual = 365;
const expectedNetAccrualRateBps = new BigNumber(testAccrualRateBps / divisorForAccrual).
    times(new BigNumber(1 - testBonusPoolShare - testClientCoShare - testPrudentialDiscountFactor));

// const testAccumulatedBalance = BigNumber(Math.floor(10000 * 100 * 100 * Math.random()));
const toHundredthCent = 100 * 100;
const testAmountUsd = 500;
const testAccumulatedBalance = new BigNumber(testAmountUsd * toHundredthCent);
const expectedAmountAccruedToday = testAccumulatedBalance.times(expectedNetAccrualRateBps).dividedBy(toHundredthCent);

const expectedBalanceToday = testAccumulatedBalance.plus(expectedAmountAccruedToday).decimalPlaces(0).toNumber();

const expectedNumberOfDays = 5;
const effectiveDailyRate = new BigNumber(expectedAmountAccruedToday).dividedBy(new BigNumber(testAccumulatedBalance));
const expectedBalanceSubsequentDays = Array.from(Array(expectedNumberOfDays).keys()).map((day) => {
    // note: lots of bignumber and fp weirdness to watch out for in here, hence splitting it and making very explicit
    const rebasedDay = day + 1;
    const multiplier = effectiveDailyRate.plus(1).pow(rebasedDay + 1);
    const endOfDay = testTimeEOD.clone().add(rebasedDay, 'days');
    return {
        'amount': testAccumulatedBalance.times(multiplier).decimalPlaces(0).toNumber(),
        'currency': 'USD',
        'unit': 'HUNDREDTH_CENT',
        'datetime': endOfDay.format(),
        'epochMilli': endOfDay.valueOf(),
        'timezone': endOfDay.tz()
    };
});

const accountBalanceQueryStub = sinon.stub();
const accountClientFloatStub = sinon.stub();
const findAccountsForUserStub = sinon.stub();
const floatPrincipalVarsStub = sinon.stub();

const handler = proxyquire('../handler', {
    './persistence/rds': { 
        'sumAccountBalance': accountBalanceQueryStub,
        'findFloatForAccount': accountClientFloatStub,
        'findAccountsForUser': findAccountsForUserStub
    },
    './persistence/dynamodb': {
        fetchSingleRow: floatPrincipalVarsStub
    },
    '@noCallThru': true
});

const resetStubs = () => {
    accountBalanceQueryStub.reset();
    accountClientFloatStub.reset();
    findAccountsForUserStub.reset();
    floatPrincipalVarsStub.reset();
};

describe('Fetches user balance and makes projections', () => {
    
    const wellFormedResultBody = {
        balanceEndOfToday: {
            'amount': expectedBalanceToday,
            'currency': 'USD',
            'unit': 'HUNDREDTH_CENT',
            'datetime': testTimeEOD.format(),
            'epochMilli': testTimeEOD.valueOf(),
            'timezone': testTimeZone
        },
        balanceSubsequentDays: expectedBalanceSubsequentDays
    };

    before(() => {
        logger('Test time now: ', testTimeNow.format(), ' and end of day: ', testTimeEOD.format());
        logger('Expected balance at end of day: ', expectedBalanceToday);
        logger('Effective daily rate: ', effectiveDailyRate.toNumber());
        // logger('Balances subsequent days, first: ', expectedBalanceSubsequentDays[0]);

        accountBalanceQueryStub.withArgs(testAccountId, 'USD', testTimeNow).resolves({ 
            sum: expectedBalanceToday, 
            currency: 'USD', 
            unit: 'HUNDREDTH_CENT'
        });
        accountClientFloatStub.withArgs(testAccountId).resolves({ clientId: testClientId, floatId: testFloatId });
        findAccountsForUserStub.withArgs(testUserId).resolves([testAccountId]);
        
        floatPrincipalVarsStub.withArgs(testClientId, testFloatId).resolves({ 
            accrualRateAnnualBps: testAccrualRateBps, 
            bonusPoolShare: testBonusPoolShare, 
            clientCoShare: testClientCoShare,
            prudentialFactor: testPrudentialDiscountFactor
        });
    });

    beforeEach(() => resetStubs());

    it('Obtains balance and future projections correctly when given an account ID', async () => {

        const balanceAndProjections = await handler.balance({ 
            accountId: testAccountId, 
            currency: 'USD', 
            atEpochMillis: testTimeNow.valueOf(),
            timeZone: testTimeZone
        });
        
        expect(balanceAndProjections).to.exist;
        expect(balanceAndProjections.statusCode).to.equal(200);
        expect(balanceAndProjections).to.have.property('body');
        const resultBody = JSON.parse(balanceAndProjections.body);
        expect(resultBody).to.deep.equal(wellFormedResultBody);
    });

    it('Obtains balance and future projections correctly when given a system wide user ID, single and multiple accounts', async () => {
        const balanceAndProjections = await handler.balance({ 
            userId: testUserId, 
            currency: 'USD', 
            atEpochMillis: testTimeNow.valueOf(),
            timeZone: testTimeZone 
        });
        expect(balanceAndProjections).to.exist;
        expect(balanceAndProjections.statusCode).to.equal(200);
        expect(balanceAndProjections).to.have.property('body');
        const resultBody = JSON.parse(balanceAndProjections.body);
        expect(resultBody).to.deep.equal(wellFormedResultBody);
    });

    it('Returns an error code when neither account ID or user ID is provided, or no currency', async () => {
        const expectedErrorMsg = 'No account or user ID provided';
        const errorResult = await handler.balance({ currency: 'USD',
atEpochMillis: testTimeNow.valueOf() });
        expect(errorResult).to.exist;
        expect(errorResult.statusCode).to.equal(400);
        expect(errorResult.body).to.equal(expectedErrorMsg);

        const expectedNoCurrencyMsg = 'No currency provided for this request';
        const errorResultCurrency = await handler.balance({ accountId: testAccountId,
atEpochMillis: testTimeNow.valueOf() });
        expect(errorResultCurrency).to.exist;
        expect(errorResultCurrency).to.have.property('statusCode', 500);
        expect(errorResultCurrency).to.have.property('body', expectedNoCurrencyMsg);
    });

    it('Returns an error code when missing time or timezone information', async () => {
        const expectedErrorMsgTime = 'No time for balance calculation provided';
        const expectedErrorMsgZone = 'No timezone provided for user';

        const errorResult1 = await handler.balance({
            accountId: testAccountId,
            currency: 'USD'
        });

        const errorResult2 = await handler.balance({
            accountId: testAccountId,
            currency: 'USD',
            atEpochMillis: testTimeNow.valueOf()
        });

        expect(errorResult1).to.have.property('statusCode', 500);
        expect(errorResult1).to.have.property('body', expectedErrorMsgTime);
        expect(errorResult2).to.have.property('statusCode', 500);
        expect(errorResult2).to.have.property('body', expectedErrorMsgZone);
    });

});
