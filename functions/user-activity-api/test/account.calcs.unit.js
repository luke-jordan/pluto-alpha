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
        expect(queryStub).to.have.been.calledWith(expectedInterestQuery, expectedValues);
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
        expect(queryStub).to.have.been.calledWith(expectedBalanceQuery, expectedValues);
    });

    it('Gracefully handles unknown parameter', async () => {
        const resultOfBadQuery = await accountCalculator.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'some_weird_thing' });
        logger('Result of bad query: ', resultOfBadQuery);
        expect(resultOfBadQuery).to.be.null;
    });
});
