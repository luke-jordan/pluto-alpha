'use strict';

const logger = require('debug')('jupiter:admin:rds-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');
const camelCaseKeys = require('camelcase-keys');

const queryStub = sinon.stub();
const updateRecordStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.updateRecord = updateRecordStub;
    }
}

const persistence = proxyquire('../persistence/rds.account', {
    'rds-common': MockRdsConnection
});

describe('*** UNIT TEST RDS ACCOUNT FUNCTIONS ***', () => {

    const accountTable = config.get('tables.accountTable');
    const transactionTable = config.get('tables.transactionTable');

    const expectedPendingTx = {
        'transaction_id': uuid(),
        'account_id': uuid(),
        'creation_time': moment().format(),
        'transaction_type': 'ALLOCATION',
        'settlement_status': 'SETTLED',
        'amount': '100',
        'currency': 'USD',
        'unit': 'HUNDREDTH_CENT',
        'human_reference': 'FRTNX191'
    };

    const MAX_USERS = 10000000;
    const MIN_USERS = 9000000;
    
    const generateUserCount = () => {
        const base = Math.floor(Math.random());
        const multiplier = (MAX_USERS - MIN_USERS);
        const normalizer = MIN_USERS;
        const rawResult = base * multiplier;
        return rawResult + normalizer;
    };

    beforeEach(() => {
        helper.resetStubs(queryStub, updateRecordStub);
    });

    it('Fethes user count', async () => {
        const startDate = moment();
        const endDate = moment();

        const testsUserCount = generateUserCount();

        const expectedQuery = `select count(distinct(owner_user_id)) from ${accountTable} ` + 
            `inner join ${transactionTable} on ${accountTable}.account_id = ${transactionTable}.account_id ` + 
            `where transaction_type = $1 and settlement_status = $2 and ${transactionTable}.creation_time between $3 and $4`;
        const expectedValues = [
            'USER_SAVING_EVENT',
            'SETTLED',
            sinon.match.string,
            sinon.match.string
        ];

        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'count': testsUserCount }]);

        const userCount = await persistence.countUserIdsWithAccounts(startDate, endDate);
        logger('User count:', userCount);

        expect(userCount).to.exist;
        expect(userCount).to.equal(testsUserCount);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Fetches user count where include no save is set to true', async () => {
        const startDate = moment();
        const endDate = moment();
        const testsUserCount = generateUserCount();

        const expectedQuery = `select count(distinct(owner_user_id)) from ${accountTable} left join ` + 
            `${transactionTable} on ${accountTable}.account_id = ${transactionTable}.account_id ` + 
            `where transaction_type = $1 and settlement_status = $2 and ((${transactionTable}.creation_time between $3 and $4) ` + 
            `or (${accountTable}.creation_time between $3 and $4))`;

        const expectedValues = [
            'USER_SAVING_EVENT',
            'SETTLED',
            sinon.match.string,
            sinon.match.string
        ];

        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'count': testsUserCount }]);

        const userCount = await persistence.countUserIdsWithAccounts(startDate, endDate, true);
        logger('User count:', userCount);

        expect(userCount).to.exist;
        expect(userCount).to.equal(testsUserCount);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Fetches a users pending transactions', async () => {
        const testUserId = uuid();
        const startDate = moment();

        const expectedQuery = `select transaction_id, ${accountTable}.account_id, ${transactionTable}.creation_time, ` + 
            `transaction_type, settlement_status, amount, currency, unit, human_reference from ${accountTable} inner join ${transactionTable} ` + 
            `on ${accountTable}.account_id = ${transactionTable}.account_id where ${accountTable}.owner_user_id = $1 ` + 
            `and ${transactionTable}.creation_time > $2 and settlement_status in ($3, $4)`;

        const expectedValues = [testUserId, startDate.format(), 'INITIATED', 'PENDING'];

        queryStub.withArgs(expectedQuery, expectedValues).resolves(expectedPendingTx);

        const pendingTransactions = await persistence.fetchUserPendingTransactions(testUserId, startDate);
        logger('Result of pending transaction extraction:', pendingTransactions);

        expect(pendingTransactions).to.exist;
        expect(pendingTransactions).to.deep.equal(camelCaseKeys(expectedPendingTx));
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Expires hanging transactions', async () => {
        const testTransactionId = uuid();
        const testCreationTime = moment().format();

        const expectedUpdateQuery = `update ${transactionTable} set settlement_status = $1 where settlement_status in ` + 
            `($2, $3, $4) and creation_time < $5 returning transaction_id, creation_time`;
        const expectedValues = [
            'EXPIRED',
            'INITIATED',
            'CREATED',
            'PENDING',
            sinon.match.string
        ];

        updateRecordStub.withArgs(expectedUpdateQuery, expectedValues).resolves({ rows: [
            {'transaction_id': testTransactionId, 'creation_time': testCreationTime },
            {'transaction_id': testTransactionId, 'creation_time': testCreationTime }            
        ]});

        const expectedResult = { transactionId: testTransactionId, creationTime: testCreationTime };

        const resultOfUpdate = await persistence.expireHangingTransactions();
        logger('Result of hanging transactions update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([expectedResult, expectedResult]);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(expectedUpdateQuery, expectedValues);
    });
});
