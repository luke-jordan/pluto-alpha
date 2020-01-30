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
        const txIndices = '$6, $7, $8, $9, $10';
        const sumQuery = `select sum(amount), unit from ${txTable} where account_id = $1 and currency = $2 and ` +
            `settlement_status in ($3, $4) and creation_time < to_timestamp($5) and transaction_type in (${txIndices}) group by unit`;
        // on this one we leave out the accrued
        const latestTxQuery = `select creation_time from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` +
            `and creation_time < to_timestamp($3) order by creation_time desc limit 1`;

    beforeEach(() => resetStubs());

    it('Obtain the balance of an account at a point in time correctly', async () => {
        const testTime = moment();
        const testLastTxTime = moment().subtract(5, 'hours');
        const queryArgs = [testAccountId, 'USD', 'SETTLED', 'ACCRUED', testTime.unix(), ...transTypes];
        
        logger('Test time value of: ', testTime.valueOf());
        
        queryStub.withArgs(sumQuery, queryArgs).resolves([
            { 'unit': 'HUNDREDTH_CENT', 'sum': testBalance }, { 'unit': 'WHOLE_CENT', 'sum': testBalanceCents }
        ]);
        queryStub.withArgs(latestTxQuery, [testAccountId, 'USD', testTime.unix()]).resolves([{ 'creation_time': testLastTxTime.format() }]);

        const expectedBalance = testBalance + (100 * testBalanceCents);
        
        const balanceResult = await rds.sumAccountBalance(testAccountId, 'USD', testTime);

        expect(balanceResult).to.exist;
        expect(balanceResult).to.have.property('amount', expectedBalance);
        expect(balanceResult).to.have.property('unit', 'HUNDREDTH_CENT');
        expect(balanceResult.lastTxTime.format()).to.equal(testLastTxTime.format());
    });

    it('Handle case of no prior transactions properly', async () => {
        const testTime = moment();
        const queryArgs = [testAccountId, 'USD', 'SETTLED', 'ACCRUED', testTime.unix(), ...transTypes];

        queryStub.withArgs(sumQuery, queryArgs).resolves([]);
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

    const expectedTxRow = {
        'transaction_id': testTxId,
        'account_id': testAccountId,
        'creation_time': moment().format(),
        'transaction_type': 'ALLOCATION',
        'settlement_status': 'SETTLED',
        'amount': '100',
        'currency': 'USD',
        'unit': 'HUNDREDTH_CENT',
        'human_reference': 'BUSANI7'
    };

    const testPendingTransactions = [
        {
            'transaction_type': 'USER_SAVING_EVENT',
            'amount': '100'
        },
        {
            'transaction_type': 'WITHDRAWAL',
            'amount': '50'
        }
    ];

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

    it('Fetches prior transactions', async () => {
        const selectQuery = `select * from ${config.get('tables.accountTransactions')} where account_id = $1 ` +
        `and settlement_status = $2 and transaction_type in ($3, $4, $5, $6) order by creation_time desc`;
        const selectValues = [testAccountId, 'SETTLED', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'BOOST_REDEMPTION', 'CAPITALIZATION'];

        queryStub.resolves([expectedTxRow, expectedTxRow, expectedTxRow]);
        const priorTxs = await rds.fetchTransactionsForHistory(testAccountId);
        logger('Got prior txs:', priorTxs);

        expect(priorTxs).to.exist;
        expect(priorTxs).to.deep.equal([expectedTxRow, expectedTxRow, expectedTxRow].map((row) => camelizeKeys(row)));
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, selectValues);
    });

    it('Fetches pending transactions', async () => {
        const selectQuery = `select transaction_type, amount from ${config.get('tables.accountTransactions')} where account_id = $1 ` +
        `and settlement_status = $2 and transaction_type in ($3, $4) order by creation_time desc`;
        const selectValues = [testAccountId, 'PENDING', 'USER_SAVING_EVENT', 'WITHDRAWAL'];

        queryStub.resolves(testPendingTransactions);
        const priorTxs = await rds.fetchPendingTransactions(testAccountId);
        logger('Got prior txs:', priorTxs);

        expect(priorTxs).to.exist;
        expect(priorTxs).to.deep.equal(testPendingTransactions.map((row) => camelizeKeys(row)));
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, selectValues);
    });

    it('Finds most common currency', async () => {
        const currencyQuery = `select currency, count(currency) as currency_count from ${config.get('tables.accountTransactions')} where account_id = $1 group by currency order by currency_count desc limit 1`;
        queryStub.withArgs(currencyQuery, [testAccountId]).resolves([{ 'currency': 'USD', 'currency_count': 10 }]);
        const result = await rds.findMostCommonCurrency(testAccountId);
        expect(result).to.exist;
        expect(result).to.deep.equal('USD');
        expect(queryStub).to.have.been.calledOnceWithExactly(currencyQuery, [testAccountId]);
    });

    it('Checks if a boost is available', async () => {
        const testBoostCount = 10;

        const boostQuery = `select count(*) from boost_data.boost_account_status inner join boost_data.boost on ` + 
            `boost_data.boost.boost_id = boost_data.boost_account_status.boost_id where account_id = $1 and ` +
            `boost_data.boost.active = true and boost_data.boost.end_time > current_timestamp and ` +
            `boost_data.boost_account_status.boost_status in ($2, $3, $4)`;
        const boostValues = [testAccountId, 'CREATED', 'OFFERED', 'PENDING'];        
        
        queryStub.resolves([{ 'count': testBoostCount }]);

        const result = await rds.countAvailableBoosts(testAccountId);
        expect(result).to.equal(10);

        expect(queryStub).to.have.been.calledOnceWithExactly(boostQuery, boostValues);
    });

    // just being careful; other stuff is handled above, so
    it('Returns 0 if no count', async () => {
        queryStub.resolves([]);
        const result = await rds.countAvailableBoosts(testAccountId);
        expect(result).to.equal(0);
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

    it('Fetches Finworks account number', async () => {
        const userAccountTable = config.get('tables.accountLedger');
        const selectQuery = `select tags from ${userAccountTable} where account_id = $1`;

        queryStub.resolves([{ tags: ['TEST_TAG::1', 'TEST_TAG::2', 'FINWORKS::POL1'] }]);

        const result = await rds.fetchAccountTagByPrefix(testAccountId, 'FINWORKS');
        logger('Result of FinWorks account number extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal('POL1');
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
    });

    it('Fetches bank reference information', async () => {
        const accountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const selectQuery = `select human_ref, count(transaction_id) from ${accountTable} left join ${txTable} ` +
            `on ${accountTable}.account_id = ${txTable}.account_id where ${accountTable}.account_id = $1 ` + 
            `and transaction_type = $2 group by human_ref`;

        queryStub.resolves([{ 'human_ref': 'BUS123', 'count': 2 }]);

        const bankRefInfo = await rds.fetchInfoForBankRef(testAccountId);
        logger('Result of reference info extraction:', bankRefInfo);

        expect(bankRefInfo).to.exist;
        expect(bankRefInfo).to.deep.equal({ humanRef: 'BUS123', count: 2 });
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId, 'USER_SAVING_EVENT']);
    });

    it('Checks for duplicate saves', async () => {
        const selectQuery = `select * from ${config.get('tables.accountTransactions')} where account_id = $1 and ` +
            `amount = $2 and currency = $3 and unit = $4 and settlement_status = $5 and ` +
            `creation_time > $6 order by creation_time desc limit 1`;

        const selectValues = [testAccountId, testSaveAmount, 'ZAR', 'HUNDREDTH_CENT', 'INITIATED', sinon.match.string];

        queryStub.resolves([expectedTxRow]);

        const params = {
            accountId: testAccountId,
            amount: testSaveAmount,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT'
        };

        const resultOfCheck = await rds.checkForDuplicateSave(params);
        logger('Duplicates:', resultOfCheck);

        expect(resultOfCheck).to.exist;
        expect(resultOfCheck).to.deep.equal(camelizeKeys(expectedTxRow));
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, selectValues);
    });

});
