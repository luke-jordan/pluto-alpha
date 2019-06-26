process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:balance:test');
const BigNumber = require('bignumber.js');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const testAccountId = uuid();
const testTimeNow = new Date();
const testUserId = uuid();

// const testAccountTxs = Array(10).fill().map((_) => { 
//     const testTxDate = new Date();
//     return { testTxDate: Math.floor(Math.random() * 100 * 100 * 100)};
// });

const testClientId=  'a_client_somewhere';
const testFloatId = 'usd_cash_primary';

const testAccrualRateBps = 250;
const testBonusPoolShare = 0.1; // percent of an accrual (not bps)
const testClientCoShare = 0.05; // as above
const testPrudentialDiscountFactor = 0.1; // percent, how much to reduce projected increment by

const expectedNetAccrualRateBps = BigNumber(testAccrualRateBps / 365).times(BigNumber((1 - testBonusPoolShare - testClientCoShare - testPrudentialDiscountFactor)));

const testAccumulatedBalance = BigNumber(Math.floor(10000 * 100 * 100 * Math.random()));
const expectedAmountAccruedToday = testAccumulatedBalance.times(expectedNetAccrualRateBps).dividedBy(100 * 100);

const expectedBalanceToday = testAccumulatedBalance + expectedAmountAccruedToday;
const expectedBalanceSubsequentDays = [];

const accountBalanceQueryStub = sinon.stub();
const accountClientFloatStub = sinon.stub();
const findAccountsForUserStub = sinon.stub();
const floatPrincipalVarsStub = sinon.stub();

const handler = proxyquire('../handler', {
    './persistence/rds': { 
        'sumAccountBalance': accountBalanceQueryStub,
        'findFloatForAccount': accountClientFloatStub,
        'findAccountsForUser': findAccountsForUserStub,
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

    before(() => {
        accountBalanceQueryStub.withArgs(testAccountId, 'USD', testTimeNow).resolves({ sum: expectedBalanceToday, currency: 'USD', unit: 'HUNDREDTH_CENT'});
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

    it.only('Obtains balance and future projections correctly when given an account ID', async () => {
        logger('Expected balance: ', testAccumulatedBalance.toNumber());
        logger('Expected accrual today: ', expectedAmountAccruedToday.toNumber());
        // const balanceAndProjections = await handler.balance({ accountId: testAccountId, currency: 'USD', atTime: testTimeNow });
        // expect(balanceAndProjections).to.exist;
        // expect(balanceAndProjections.statusCode).to.equal(200);
    });

    it('Obtains balance and future projections correctly when given a system wide user ID, single and multiple accounts', async () => {
        const balanceAndProjections = await handler.balance({ userId: testUserId, currency: 'USD', atTime: testTimeNow });
        expect(balanceAndProjections).to.exist;
        expect(balanceAndProjections.statusCode).to.equal(200);
    });

    it('Returns an error code when neither account ID or user ID is provided', async () => {
        const errorResult = await handler.balance({ currency: 'USD', atTime: testTimeNow });
        expect(errorResult).to.exist;
        expect(errorResult.statusCode).to.equal(500);
    });

});
