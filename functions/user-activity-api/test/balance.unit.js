'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:balance:test');
const BigNumber = require('bignumber.js');
const moment = require('moment-timezone');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const testHelper = require('./test.helper');

const testAccountId = uuid();
const testUserId = uuid();

// note : in future at some time will need to handle user in different time zone to float
const testTimeZone = 'America/New_York';
const testTimeNow = moment.tz(testTimeZone);
logger('Set test time now to : ', testTimeNow);
const testTimeEOD = testTimeNow.clone().endOf('day');

const testClientId = 'a_client_somewhere';
const testFloatId = 'usd_cash_primary';

const testAccrualRateBps = 250;
const testBonusPoolShare = 0.1; // percent of an accrual (not bps)
const testClientCoShare = 0.05; // as above
const testPrudentialDiscountFactor = 0.1; // percent, how much to reduce projected increment by

const divisorForAccrual = 365;
const expectedNetAccrualRateBps = new BigNumber(testAccrualRateBps / divisorForAccrual).
    times(new BigNumber(1 - testBonusPoolShare - testClientCoShare - testPrudentialDiscountFactor));
logger('Net daily rate: ', expectedNetAccrualRateBps.toNumber());

// const testAccumulatedBalance = BigNumber(Math.floor(10000 * 100 * 100 * Math.random()));
const toHundredthCent = 100 * 100;
const testAmountUsd = 500;
const testAccumulatedBalance = new BigNumber(testAmountUsd).times(toHundredthCent);
const expectedAmountAccruedToday = testAccumulatedBalance.times(expectedNetAccrualRateBps).dividedBy(toHundredthCent);

const expectedBalanceToday = testAccumulatedBalance.plus(expectedAmountAccruedToday).decimalPlaces(0).toNumber();

const expectedNumberOfDays = 5;
const effectiveDailyRate = expectedAmountAccruedToday.dividedBy(testAccumulatedBalance);
logger('Effective daily rate: ', effectiveDailyRate.toNumber());
const expectedBalanceSubsequentDays = Array.from(Array(expectedNumberOfDays).keys()).map((day) => {
    // note: lots of bignumber and fp weirdness to watch out for in here, hence splitting it and making very explicit
    const rebasedDay = day + 1;
    const multiplier = effectiveDailyRate.plus(1).pow(rebasedDay + 1);
    const endOfDay = testTimeEOD.clone().add(rebasedDay, 'days');
    const balanceEndOfDay = testAccumulatedBalance.times(multiplier); 
    logger('Test end of day: ', balanceEndOfDay.toNumber());
    return {
        'amount': balanceEndOfDay.decimalPlaces(0).toNumber(),
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
        'findClientAndFloatForAccount': accountClientFloatStub,
        'findAccountsForUser': findAccountsForUserStub
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': floatPrincipalVarsStub
    },
    '@noCallThru': true
});

const resetStubs = (historyOnly = true) => {
    if (historyOnly) {
        accountBalanceQueryStub.resetHistory();
        accountClientFloatStub.resetHistory();
        findAccountsForUserStub.resetHistory();
        floatPrincipalVarsStub.resetHistory();
    } else {
        accountBalanceQueryStub.reset();
        accountClientFloatStub.reset();
        findAccountsForUserStub.reset();
        floatPrincipalVarsStub.reset();
    }
};

describe('Fetches user balance and makes projections', () => {
    
    const wellFormedResultBody = {
        accountId: [testAccountId],
        currentBalance: {
            'amount': testAccumulatedBalance.decimalPlaces(0).toNumber(),
            'unit': 'HUNDREDTH_CENT',
            'currency': 'USD',
            'datetime': testTimeNow.format(),
            'epochMilli': testTimeNow.valueOf(),
            'timezone': testTimeZone
        },
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

    const checkResultIsWellFormed = (balanceAndProjections, expectedBody = wellFormedResultBody) => {
        expect(balanceAndProjections).to.exist;
        expect(balanceAndProjections.statusCode).to.equal(200);
        expect(balanceAndProjections).to.have.property('body');
        const resultBody = JSON.parse(balanceAndProjections.body);
        expect(resultBody).to.deep.equal(expectedBody);
    };

    const checkErrorResultForMsg = (errorResult, expectedErrorMsg) => {
        expect(errorResult).to.exist;
        expect(errorResult.statusCode).to.equal(400);
        expect(errorResult.body).to.equal(expectedErrorMsg);
    };

    const stripCurrBalanceDateTime = (expectedBody) => {
        const strippedBalance = expectedBody.currentBalance;
        Reflect.deleteProperty(strippedBalance, 'datetime');
        Reflect.deleteProperty(strippedBalance, 'epochMilli');
        expectedBody.currentBalance = strippedBalance;
        return expectedBody;
    };

    before(() => {
        // logger('Test time now: ', testTimeNow.format(), ' and end of day: ', testTimeEOD.format());
        // logger('Expected balance at end of day: ', expectedBalanceToday);
        // logger('Effective daily rate: ', effectiveDailyRate.toNumber());
        // logger('Balances subsequent days, first: ', expectedBalanceSubsequentDays[0]);
        // resetStubs(false);
        
        accountBalanceQueryStub.withArgs(testAccountId, 'USD', testHelper.anyMoment).resolves({ 
            amount: testAccumulatedBalance.decimalPlaces(0).toNumber(), 
            unit: 'HUNDREDTH_CENT'
        });
        accountClientFloatStub.withArgs(testAccountId).resolves({ clientId: testClientId, floatId: testFloatId });
        findAccountsForUserStub.withArgs(testUserId).resolves([testAccountId]);
        
        floatPrincipalVarsStub.withArgs(testClientId, testFloatId).resolves({ 
            accrualRateAnnualBps: testAccrualRateBps, 
            bonusPoolShareOfAccrual: testBonusPoolShare, 
            clientShareOfAccrual: testClientCoShare,
            prudentialFactor: testPrudentialDiscountFactor,
            defaultTimezone: 'America/New_York',
            currency: 'USD'
        });
    });

    beforeEach(() => resetStubs(true));

    after(() => resetStubs(false));

    it('The wrapper retrieves defaults, and processes, based on auth context', async () => {
        const authContext = {
            systemWideUserId: testUserId
        };
        // accountBalanceQueryStub.withArgs(testAccountId, 'USD', testHelper.anyMoment);
        const balanceAndProjections = await handler.balanceWrapper(null, authContext);
        
        // logger('Received: ', balanceAndProjections);
        const expectedBody = stripCurrBalanceDateTime(JSON.parse(JSON.stringify(wellFormedResultBody)));
        
        // usual sinon annoying stubornness on matching means passing to helper isn't working, so unspooling
        expect(balanceAndProjections).to.exist.and.have.property('statusCode', 200);
        const bodyReturned = JSON.parse(balanceAndProjections.body);
        expect(bodyReturned).to.exist;
        expect(bodyReturned.currentBalance.datetime).to.be.a.string;
        expect(bodyReturned.currentBalance.epochMilli).to.be.a('number');
        // and this is the point at which I truly loathe Sinon and matchers, which can be utterly stupid; what follows 
        // becomes necessary to get around matching equality
        const strippedReturned = stripCurrBalanceDateTime(bodyReturned);
        expect(strippedReturned).to.deep.equal(expectedBody);
    
    });


    it('Obtains balance and future projections correctly when given an account ID', async () => {
        const balanceAndProjections = await handler.balance({ 
            accountId: testAccountId,
            clientId: testClientId,
            floatId: testFloatId, 
            currency: 'USD', 
            atEpochMillis: testTimeNow.valueOf(),
            timezone: testTimeZone
        });
        logger('Result: ', balanceAndProjections);
        checkResultIsWellFormed(balanceAndProjections);
    });

    it('Obtains balance and future projections correctly when given a system wide user ID, single and multiple accounts', async () => {
        const balanceAndProjections = await handler.balance({ 
            userId: testUserId, 
            currency: 'USD', 
            atEpochMillis: testTimeNow.valueOf(),
            timezone: testTimeZone,
            clientId: testClientId,
            floatId: testFloatId 
        });

        checkResultIsWellFormed(balanceAndProjections);
    });

    it('Obtains balance and future projections for default client and float when given an account Id or user Id', async () => {
        const commonParams = {
            currency: 'USD',
            atEpochMillis: testTimeNow.valueOf(),
            timezone: testTimeZone
        };

        const accountIdParams = JSON.parse(JSON.stringify(commonParams));
        accountIdParams.accountId = testAccountId;
        const userIdParams = JSON.parse(JSON.stringify(commonParams));
        userIdParams.userId = testUserId;

        const balanceAndProjectionsAccountId = await handler.balance(accountIdParams);
        checkResultIsWellFormed(balanceAndProjectionsAccountId);

        const balanceAndProjectionsUserId = await handler.balance(userIdParams);
        checkResultIsWellFormed(balanceAndProjectionsUserId);
    });

    it('Obtains balance but leaves out future projections if days to project is is 0', async () => {
        const zeroDaysParams = {
            userId: testUserId,
            currency: 'USD',
            atEpochMillis: testTimeNow.valueOf(),
            timezone: testTimeZone,
            daysToProject: 0
        };

        const resultWithoutDays = JSON.parse(JSON.stringify(wellFormedResultBody));
        Reflect.deleteProperty(resultWithoutDays, 'balanceSubsequentDays');
        const balanceWithoutProjections = await handler.balance(zeroDaysParams);
        logger('Result: ', balanceWithoutProjections);
        checkResultIsWellFormed(balanceWithoutProjections, resultWithoutDays);
    });

    it('Returns an error code when neither account ID or user ID is provided, or no currency', async () => {
        const expectedErrorMsg = 'No account or user ID provided';
        const errorResult = await handler.balance({ currency: 'USD', atEpochMillis: testTimeNow.valueOf() });
        checkErrorResultForMsg(errorResult, expectedErrorMsg);

        const expectedNoCurrencyMsg = 'No currency provided for this request';
        const errorResultCurrency = await handler.balance({ accountId: testAccountId, atEpochMillis: testTimeNow.valueOf() });
        checkErrorResultForMsg(errorResultCurrency, expectedNoCurrencyMsg);
    });

    it('Returns an error code when timezone information, but defaults to current time if no time given', async () => {
        const expectedErrorMsgTime = 'No time for balance calculation provided';
        const expectedErrorMsgZone = 'No timezone provided for user';

        const errorResult1 = await handler.balance({
            accountId: testAccountId,
            timezone: testTimeZone,
            currency: 'USD'
        });
        checkErrorResultForMsg(errorResult1, expectedErrorMsgTime);

        const errorResult2 = await handler.balance({
            accountId: testAccountId,
            currency: 'USD',
            atEpochMillis: testTimeNow.valueOf()
        });
        checkErrorResultForMsg(errorResult2, expectedErrorMsgZone);

    });

});
