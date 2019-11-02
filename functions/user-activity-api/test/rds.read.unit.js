'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:activity-rds:test');
const config = require('config');
const moment = require('moment-timezone');
const camelcase = require('camelcase');
const testHelper = require('./test.helper');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const rds = proxyquire('../persistence/rds', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => {
    testHelper.resetStubs(queryStub, insertStub, multiTableStub, multiOpStub, uuidStub);
    uuidStub.callsFake(uuid); // not actually a fake but call through is tricky, so this is simpler
};

const expectNoCalls = (stubList) => stubList.forEach((stub) => expect(stub).to.not.have.been.called);

const testFloatId = 'zar_cash_float';
const testClientId = 'pluto_savings_za';
const testUserId = uuid();
const testAccountId = uuid();

describe('*** USER ACTIVITY *** UNIT TEST RDS *** : Fetch floats and find transactions', () => {
    
    beforeEach(resetStubs);

    it('Obtain a default float id and client id', async () => {
        const queryString = 'select owner_user_id, default_float_id, responsible_client_id from account_data.core_account_ledger where account_id = $1';
        queryStub.withArgs(queryString, sinon.match([testAccountId])).resolves([{ 
            'default_float_id': testFloatId,
            'responsible_client_id': testClientId,
            'owner_user_id': testUserId
        }]);
        const floatResult = await rds.getOwnerInfoForAccount(testAccountId);
        expect(floatResult).to.exist;
        expect(floatResult).to.deep.equal({ clientId: testClientId, floatId: testFloatId, systemWideUserId: testUserId });
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, sinon.match([testAccountId]));
        expectNoCalls([insertStub, multiTableStub]);
    });

    it('Find a prior matching transaction, by account ID and amount', async () => {
        const testAmount = 100;
        // cut off time should be a configurable thing
        const cutOffTime = moment.tz('America/New_York').subtract(30, 'minutes'); 
        const queryString = 'select transaction_id from account_data.core_account_ledger where account_id = $1 and amount = $2 and ' + 
            'currency = $3 and unit = $4 and creation_time < to_timestamp($5) order by creation_time ascending';
        const queryParams = sinon.match([testAccountId, testAmount, 'ZAR', 'HUNDREDTH_CENT', cutOffTime.valueOf()]);
        
        const testMatchingTxId = uuid();
        queryStub.withArgs(queryString, queryParams).resolves([{ 'transaction_id': testMatchingTxId }]);
        
        const findResult = await rds.findMatchingTransaction({ 
            accountId: testAccountId, 
            amount: testAmount, 
            currency: 'ZAR', 
            unit: 'HUNDREDTH_CENT', 
            cutOffTime: cutOffTime
        });
        
        expect(findResult).to.exist;
        expect(findResult).to.deep.equal({ transactionId: testMatchingTxId });
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, queryParams);
        expectNoCalls([insertStub, multiTableStub]);
    });

    it('Fail to find a prior matching transaction', async () => {
        const queryString = 'select transaction_id from account_data.core_account_ledger where account_id = $1 and amount = $2 and ' + 
            'currency = $3 and unit = $4 and creation_time < to_timestamp($5) order by creation_time ascending';
        const cutOffTime = moment.tz('America/New_York').subtract(1, 'minutes'); 
        const queryParams = sinon.match([testAccountId, 101, 'ZAR', 'HUNDREDTH_CENT', cutOffTime.valueOf()]);
        queryStub.withArgs(queryString, queryParams).resolves([{}]);

        const findResult = await rds.findMatchingTransaction({ 
            accountId: testAccountId,
            amount: 101,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            cutOffTime: cutOffTime
        });
        expect(findResult).to.exist;
        expect(findResult).to.deep.equal({});
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, queryParams);
        expectNoCalls([insertStub, multiTableStub]);
    });

    // it('Call up a transaction via payment ref', async () => { });
    
});

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Sums balances', () => {

    const testUserId1 = uuid();

    const testUserId2 = uuid();
    const testAccoundIdsMulti = [uuid(), uuid(), uuid()];

    const testBalance = Math.floor(100 * 100 * 100 * Math.random());
    const testBalanceCents = Math.round(testBalance);

    const txTable = config.get('tables.accountTransactions');
        const transTypes = ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'];
        const txIndices = '$5, $6, $7, $8, $9';
        const unitQuery = `select distinct(unit) from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` + 
            `and creation_time < to_timestamp($3)`;
        const sumQuery = `select sum(amount), unit from ${txTable} where account_id = $1 and currency = $2 and unit = $3 and settlement_status = 'SETTLED' ` +
            `and creation_time < to_timestamp($4) and transaction_type in (${txIndices}) group by unit`;
        const latestTxQuery = `select creation_time from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` +
            `and creation_time < to_timestamp($3) order by creation_time desc limit 1`;

    beforeEach(() => resetStubs());

    it('Obtain the balance of an account at a point in time correctly', async () => {
        const testTime = moment();
        const testLastTxTime = moment().subtract(5, 'hours');
        const unitQueryArgs = sinon.match([testAccountId, 'USD', testTime.unix()]);
        
        logger('Test time value of: ', testTime.valueOf());
        
        queryStub.withArgs(unitQuery, unitQueryArgs).resolves([{ 'unit': 'HUNDREDTH_CENT' }, { 'unit': 'WHOLE_CENT' }]);
        queryStub.withArgs(sumQuery, [testAccountId, 'USD', 'HUNDREDTH_CENT', testTime.unix(), ...transTypes]).
            returns(Promise.resolve([{ 'sum': testBalance, 'unit': 'HUNDREDTH_CENT' }]));
        queryStub.withArgs(sumQuery, [testAccountId, 'USD', 'WHOLE_CENT', testTime.unix(), ...transTypes]).
            returns(Promise.resolve([{ 'sum': testBalanceCents, 'unit': 'WHOLE_CENT' }]));
        queryStub.withArgs(latestTxQuery, [testAccountId, 'USD', testTime.unix()]).
            returns(Promise.resolve([{ 'creation_time': testLastTxTime._d }]));
        const expectedBalance = testBalance + (100 * testBalanceCents);
        
        const balanceResult = await rds.sumAccountBalance(testAccountId, 'USD', testTime);

        expect(balanceResult).to.exist;
        expect(balanceResult).to.have.property('amount', expectedBalance);
        expect(balanceResult).to.have.property('unit', 'HUNDREDTH_CENT');
        expect(balanceResult).to.have.property('lastTxTime');
        // result of sinon hatred
        const balanceLastTxTime = balanceResult.lastTxTime;
        expect(testLastTxTime.isSame(balanceLastTxTime)).to.be.true;
        // expect(balanceResult).to.deep.equal({ amount: expectedBalance, unit: 'HUNDREDTH_CENT', lastTxTime: testHelper.momentMatchertestLastTxTime });
    });

    it('Handle case of no prior transactions properly', async () => {
        const testTime = moment();
        const unitQueryArgs = sinon.match([testAccountId, 'USD', testTime.unix()]);

        queryStub.withArgs(unitQuery, unitQueryArgs).resolves([]);
        queryStub.withArgs(latestTxQuery, [testAccountId, 'USD', testTime.unix()]).resolves([]);
        
        const balanceResult = await rds.sumAccountBalance(testAccountId, 'USD', testTime);
        logger('Result:', balanceResult);
        expect(balanceResult).to.exist;
        expect(balanceResult).to.deep.equal({ amount: 0, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
    });

    it('Find an account ID for a user ID, single and multiple', async () => {
        // most recent account first
        const findQuery = 'select account_id from account_data.core_account_ledger where owner_user_id = $1 order by creation_time desc';
        queryStub.withArgs(findQuery, [testUserId1]).resolves([{ 'account_id': testAccountId }]);
        const multiAccountList = testAccoundIdsMulti.map((accountId) => ({ 'account_id': accountId }));
        queryStub.withArgs(findQuery, [testUserId2]).resolves(multiAccountList);

        const resultOfAccountQuerySingle = await rds.findAccountsForUser(testUserId1);
        expect(resultOfAccountQuerySingle).to.exist;
        expect(resultOfAccountQuerySingle).to.deep.equal([testAccountId]);

        const resultOfAccountQueryMultiple = await rds.findAccountsForUser(testUserId2);
        expect(resultOfAccountQueryMultiple).to.exist;
        expect(resultOfAccountQueryMultiple).to.deep.equal(testAccoundIdsMulti);

        expect(queryStub.callCount).to.equal(2);
        expect(queryStub.getCall(0).calledWithExactly(findQuery, [testUserId1])).to.equal(true);
        expect(queryStub.getCall(1).calledWithExactly(findQuery, [testUserId2])).to.equal(true);
        expectNoCalls([insertStub, multiTableStub]);
    });

});

describe('*** UNIT TEST UTILITY FUNCTIONS ***', async () => {

    const testTxId = uuid();
    const testSaveAmount = 1000;
    
    const expectedRowItem = {
        'account_transaction_id': testTxId,
        'account_id': testAccountId,
        'currency': 'ZAR',
        'unit': 'HUNDREDTH_CENT',
        'amount': testSaveAmount,
        'float_id': testFloatId,
        'client_id': testClientId,
        'settlement_status': 'SETTLED',
        'initiation_time': moment().subtract(5, 'minutes').format(),
        'settlement_time': moment().format()
    };

    const camelizeKeys = (object) => Object.keys(object).reduce((o, key) => ({ ...o, [camelcase(key)]: object[key] }), {});

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches transaction', async () => {
        const txQuery = `select * from ${config.get('tables.accountTransactions')} where transaction_id = $1`;
        queryStub.withArgs(txQuery, [testTxId]).resolves([expectedRowItem]);
        const result = await rds.fetchTransaction(testTxId);
        expect(result).to.exist;
        expect(result).to.deep.equal(camelizeKeys(expectedRowItem));
        expect(queryStub).to.have.been.calledOnceWithExactly(txQuery, [testTxId]);
    });

    it('Finds most common currency', async () => {
        const currencyQuery = `select currency, count(currency) as currency_count from ${config.get('tables.accountTransactions')} where account_id = $1 group by currency order by currency_count desc limit 1`;
        queryStub.withArgs(currencyQuery, [testAccountId]).resolves([{ 'currency': 'USD', 'currency_count': 10 }]);
        const result = await rds.findMostCommonCurrency(testAccountId);
        expect(result).to.exist;
        expect(result).to.deep.equal('USD');
        expect(queryStub).to.have.been.calledOnceWithExactly(currencyQuery, [testAccountId]);
    });

    it('Counts settled saves', async () => {
        const countQuery = `select count(transaction_id) from ${config.get('tables.accountTransactions')} where account_id = $1 and ` +
            `transaction_type = $2 and settlement_status = $3`;
        queryStub.withArgs(countQuery, [testAccountId, 'USER_SAVING_EVENT', 'SETTLED']).resolves([{ 'count': 12 }]);
        const resultOfCount = await rds.countSettledSaves(testAccountId);
        expect(resultOfCount).to.exist;
        expect(resultOfCount).to.deep.equal(12);
        expect(queryStub).to.have.been.calledOnceWithExactly(countQuery, [testAccountId, 'USER_SAVING_EVENT', 'SETTLED']);
    });

    it('Returns 0 where no settled saves are found', async () => {
        const countQuery = `select count(transaction_id) from ${config.get('tables.accountTransactions')} where account_id = $1 and ` +
            `transaction_type = $2 and settlement_status = $3`;
        queryStub.withArgs(countQuery, [testAccountId, 'USER_SAVING_EVENT', 'SETTLED']).resolves([]);
        const resultOfCount = await rds.countSettledSaves(testAccountId);
        expect(resultOfCount).to.exist;
        expect(resultOfCount).to.deep.equal(0);
        expect(queryStub).to.have.been.calledOnceWithExactly(countQuery, [testAccountId, 'USER_SAVING_EVENT', 'SETTLED']);
    });

});