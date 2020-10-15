'use strict';

// const logger = require('debug')('jupiter:activity:test');
const config = require('config');
const moment = require('moment-timezone');
const camelcase = require('camelcase');

const testHelper = require('./test.helper');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const uuid = require('uuid/v4');

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const updateRecordStub = sinon.stub();
const updateRecordsStub = sinon.stub();
const multiTableStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.updateRecord = updateRecordStub;
        this.updateRecordObject = updateRecordsStub;
        this.largeMultiTableInsert = multiTableStub;
    }
}

const rds = proxyquire('../persistence/rds.lock', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe('*** UNIT TEST RDS LOCK FUNCTIONS ***', () => {
    beforeEach(() => testHelper.resetStubs(queryStub, updateRecordStub, updateRecordsStub));

    it('Updates settlement status to LOCKED, sets lock expiry and bonus amount tag', async () => {
        const testTransactionId = uuid();

        const testUpdatedTime = moment().format();
        const lockedUntilTime = moment().add(30, 'days').format();
    
        updateRecordsStub.resolves([{ 'updated_time': testUpdatedTime }]);
    
        const expectedArgs = {
            key: { transactionId: testTransactionId},
            value: { settlementStatus: 'LOCKED', lockedUntilTime },
            table: config.get('tables.accountTransactions'),
            returnClause: 'updated_time'
        };
    
        const updateResult = await rds.lockTransaction(testTransactionId, 30);
    
        expect(updateResult).to.exist;
        expect(updateResult).to.have.property('updatedTime');
        expect(updateResult.updatedTime).to.deep.equal(moment(testUpdatedTime));
        expect(updateRecordsStub).to.have.been.calledOnceWithExactly(expectedArgs);
    });
    
    it('Unlocks locked transactions with expired locks', async () => {
        const accountTxTable = config.get('tables.accountTransactions');
        const testTxIds = [uuid(), uuid()];
    
        const updateTime = moment();
    
        updateRecordStub.resolves({ rows: [
            { 'updated_time': updateTime.format(), 'transaction_id': testTxIds[0] },
            { 'updated_time': updateTime.format(), 'transaction_id': testTxIds[1] }
        ]});
    
        const updateResult = await rds.unlockTransactions(testTxIds);
    
        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(testTxIds);
    
        const expectedQuery = `update ${accountTxTable} set settlement_status = $1 and locked_until_time = null ` +
            `where settlement_status = $2 and locked_until_time < current_timestamp and ` +
            `transaction_id in ($3, $4) returning updated_time, transaction_id`;
        const expectedValues = ['SETTLED', 'LOCKED', ...testTxIds];
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });
    
    it('Fetches transactions with expired locks', async () => {
        const accountTxTable = config.get('tables.accountTransactions');
        const accountTable = config.get('tables.accountLedger');

        const testUserId = uuid();
        const testTxId = uuid();
    
        const testLockExpiryTime = moment().subtract(1, 'day');
    
        const testTxFromRds = {
            'transaction_id': testTxId,
            'transaction_type': 'USER_SAVING_EVENT',
            'settlement_status': 'LOCKED',
            'lockedUntil_time': testLockExpiryTime.format(),
            'owner_user_id': testUserId
        };
    
        queryStub.resolves([testTxFromRds]);
    
        const expiredLockedTx = await rds.fetchExpiredLockedTransactions();
    
        const expectedResult = [{
            transactionId: testTxId,
            transactionType: 'USER_SAVING_EVENT',
            settlementStatus: 'LOCKED',
            lockedUntilTime: testLockExpiryTime.format(),
            ownerUserId: testUserId
        }];
    
        expect(expiredLockedTx).to.deep.equal(expectedResult);
    
        const expectedQuery = `select ${accountTxTable}.*, ${accountTable}.owner_user_id from ${accountTxTable} ` +
            `inner join ${accountTable} on ${accountTxTable}.account_id = ${accountTable}.account_id where ` +
            `settlement_status = $1 and locked_until_time is not null and locked_until_time < current_timestamp`;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['LOCKED']);
    });

});

describe('*** UNIT TEST UTILITY FUNCTIONS ***', () => {
    const testTxId = uuid();
    const testAccountId = uuid();

    const testUserId1 = uuid();
    const testUserId2 = uuid();

    const testAccoundIdsMulti = [uuid(), uuid(), uuid()];

    const testClientId = 'a_client_id';
    const testFloatId = 'primary_cash';

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

    const expectNoCalls = (stubList) => stubList.forEach((stub) => expect(stub).to.not.have.been.called);

    beforeEach(() => testHelper.resetStubs(queryStub, insertStub, multiTableStub));

    it('Fetches transaction', async () => {
        const txQuery = `select * from ${config.get('tables.accountTransactions')} where transaction_id = $1`;
        queryStub.withArgs(txQuery, [testTxId]).resolves([expectedRowItem]);
        const result = await rds.fetchTransaction(testTxId);
        expect(result).to.exist;
        expect(result).to.deep.equal(camelizeKeys(expectedRowItem));
        expect(queryStub).to.have.been.calledOnceWithExactly(txQuery, [testTxId]);
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
