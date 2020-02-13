'use strict';

const logger = require('debug')('jupiter:activity-rds:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire').noCallThru();

const queryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
    }
}

const accountCalculator = proxyquire('../persistence/account.calculations', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});


describe('*** UNIT TEST USER ACCOUNT BALANCE EXTRACTION ***', async () => {

    const testUserId = uuid();

    beforeEach(() => queryStub.reset());

    it('Retrieves and sums user interest correctly', async () => {
        const userAccountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const expectedInterestQuery = `select sum(amount), unit from ${userAccountTable} inner join ${txTable} ` +
            `on ${userAccountTable}.account_id = ${config.get('tables.accountTransactions')}.account_id ` + 
            `where owner_user_id = $1 and currency = $2 and settlement_status = $3 and ${txTable}.creation_time > $4 ` + 
            `and transaction_type in ($5, $6) group by unit`;
        const expectedValues = [testUserId, 'USD', 'SETTLED', moment(0).format(), 'ACCRUAL', 'CAPITALIZATION'];

        queryStub.resolves([{ sum: 10, unit: 'WHOLE_CURRENCY' }, { sum: 100000, unit: 'HUNDREDTH_CENT' }]);
        const resultOfInterest = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'interest::WHOLE_CURRENCY::USD::0'});
        logger('Result of interest calc: ', resultOfInterest);
        logger('args    :', queryStub.getCall(0).args);
        logger('expected:', [expectedInterestQuery, expectedValues]);

        expect(resultOfInterest).to.deep.equal({ amount: 20, unit: 'WHOLE_CURRENCY', currency: 'USD' });
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedInterestQuery, expectedValues);
    });

    it('Retrieves and sums user balance correctly', async () => {
        const userAccountTable = config.get('tables.accountLedger');

        const expectedBalanceQuery = `select sum(amount), unit from ${userAccountTable} inner join ${config.get('tables.accountTransactions')} ` +
            `on ${userAccountTable}.account_id = ${config.get('tables.accountTransactions')}.account_id ` +
            `where owner_user_id = $1 and currency = $2 and settlement_status = $3 group by unit`;
        const expectedValues = [testUserId, 'USD', 'SETTLED'];

        queryStub.resolves([{ sum: 10, unit: 'WHOLE_CURRENCY' }, { sum: 100000, unit: 'HUNDREDTH_CENT' }]);
        const resultOfInterest = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'balance::WHOLE_CURRENCY::USD::100'});
        logger('Result of interest calc: ', resultOfInterest);
        logger('args    :', queryStub.getCall(0).args);
        logger('expected:', [expectedBalanceQuery, expectedValues]);

        expect(resultOfInterest).to.deep.equal({ amount: 20, unit: 'WHOLE_CURRENCY', currency: 'USD' });
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedBalanceQuery, expectedValues);
    });

    it('Retrieves last capitalization event correctly', async () => {
        const userAccountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const testStartTimeMillis = moment().subtract(5, 'days').valueOf();
        const testEndTimeMillis = moment().valueOf();

        const expectedCapitalizationQuery = `select sum(amount), unit from account_data.core_account_ledger ` +
            `inner join transaction_data.core_transaction_ledger on ${userAccountTable}.account_id = ${txTable}.account_id ` +
            `where owner_user_id = $1 and transaction_type = $2 and settlement_status = $3 ` +
            `and currency = $4 and creation_time between $5 and $6 group by unit`;
        const expectedValues = [testUserId, 'CAPITALIZATION', 'SETTLED', 'WHOLE_CURRENCY', moment(testStartTimeMillis).format(), moment(testEndTimeMillis).format()];

        queryStub.resolves([{ sum: 10, unit: 'WHOLE_CURRENCY' }, { sum: 100000, unit: 'HUNDREDTH_CENT' }]);
        const resultOfCapitalization = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: `capitalization::WHOLE_CURRENCY::${testStartTimeMillis}::${testEndTimeMillis}`});
        logger('Result of capitalization: ', resultOfCapitalization);
        expect(resultOfCapitalization).to.deep.equal({ amount: 200000, unit: 'HUNDREDTH_CENT', currency: 'WHOLE_CURRENCY' });
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedCapitalizationQuery, expectedValues);
    });

    it('Retrieves and sums user earnings correctly', async () => {
        const userAccountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const testStartTimeMillis = moment().subtract(5, 'days').valueOf();
        const testEndTimeMillis = moment().valueOf();

        const expectedEarningsQuery = `select sum(amount), unit from ${userAccountTable} ` +
            `inner join ${txTable} on ${userAccountTable}.account_id = ${txTable}.account_id ` +
            `where owner_user_id = $1 and currency = $2 and settlement_status = $3 and creation_time > $4 and ` +
            `creation_time < 5 and transaction_type in ($6, $7, $8) group by unit`;
        const expectedValues = [testUserId, 'WHOLE_CURRENCY', 'SETTLED', moment(testStartTimeMillis).format(), moment(testEndTimeMillis).format(), 'ACCRUAL', 'CAPITALIZATION', 'BOOST_REDEMPTION'];

        queryStub.resolves([{ sum: 10, unit: 'WHOLE_CURRENCY' }, { sum: 100000, unit: 'HUNDREDTH_CENT' }]);
        const resultOfEarnings = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: `total_earnings::HUNDREDTH_CENT::WHOLE_CURRENCY::${testStartTimeMillis}::${testEndTimeMillis}`});
        logger('Result of capitalization: ', resultOfEarnings);
        expect(resultOfEarnings).to.deep.equal({ amount: 200000, unit: 'HUNDREDTH_CENT', currency: 'WHOLE_CURRENCY' });
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedEarningsQuery, expectedValues);
    });

    it('Retrieves and sums user net savings correctly', async () => {
        const userAccountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const testStartTimeMillis = moment().subtract(5, 'days').valueOf();
        const testEndTimeMillis = moment().valueOf();

        const expectedSavingsQuery = `select sum(amount), unit from ${userAccountTable} inner ` +
            `join ${txTable} on account_data.core_account_ledger.account_id = transaction_data.core_transaction_ledger.account_id ` +
            `where owner_user_id = $1 and currency = $2 and settlement_status = $3 and creation_time > $4 and ` +
            `creation_time < 5 and transaction_type in ($6, $7) group by unit`;
        const expectedValues = [testUserId, 'WHOLE_CURRENCY', 'SETTLED', moment(testStartTimeMillis).format(), moment(testEndTimeMillis).format(), 'USER_SAVING_EVENT', 'WITHDRAWAL'];

        queryStub.resolves([{ sum: 10, unit: 'WHOLE_CURRENCY' }, { sum: 100000, unit: 'HUNDREDTH_CENT' }]);
        const resultOfSavings = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: `net_saving::HUNDREDTH_CENT::WHOLE_CURRENCY::${testStartTimeMillis}::${testEndTimeMillis}`});
        logger('Result of savings: ', resultOfSavings);
        expect(resultOfSavings).to.deep.equal({ amount: 200000, unit: 'HUNDREDTH_CENT', currency: 'WHOLE_CURRENCY' });
        expect(queryStub).to.have.been.calledWith(expectedSavingsQuery, expectedValues);
    });

    it('Retrieves user last saved amount', async () => {
        const userAccountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const expectedQuery = `select amount, unit from ${userAccountTable} inner join ${txTable} ` +
            `on ${userAccountTable}.account_id = ${txTable}.account_id where owner_user_id = $1 ` +
            `and transaction_type = $2 and settlement_status = $3 order by ${txTable}.creation_time desc limit 1`;
        const expectedValues = [testUserId, 'USER_SAVING_EVENT', 'SETTLED']; 

        queryStub.resolves([{ amount: 1000, unit: 'WHOLE_CURRENCY' }]);
        const lastSavingAmount = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: `last_saved_amount::WHOLE_CURRENCY`});
        logger('Last saved amount: ', lastSavingAmount);
        expect(lastSavingAmount).to.deep.equal({ amount: 10000000, unit: 'HUNDREDTH_CENT', currency: 'WHOLE_CURRENCY' });
        expect(queryStub).to.have.been.calledWith(expectedQuery, expectedValues);
    });

    it('Gracefully handles unknown parameter', async () => {
        const resultOfBadQuery = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'some_weird_thing' });
        logger('Result of bad query: ', resultOfBadQuery);
        expect(resultOfBadQuery).to.be.null;
    });
});
