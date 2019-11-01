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

    it('Fethes user count', async () => {
        const startDate = moment();
        const endDate = moment();

        // todo: add with args
        const expectedQuery = `select count(distinct(owner_user_id)) from account_data.core_account_ledger ` + 
            `inner join transaction_data.core_transaction_ledger on ` + 
            `account_data.core_account_ledger.account_id = transaction_data.core_transaction_ledger.account_id ` + 
            `where transaction_type = $1 and settlement_status = $2 and ` + 
            `transaction_data.core_transaction_ledger.creation_time between $3 and $4`;
        const expectedValues = [
            'USER_SAVING_EVENT',
            'SETTLED',
            sinon.match.string,
            sinon.match.string,
        ];

        // add with args
        queryStub.withArgs().resolves([{ 'count': 5000000 }]);

        const userCount = await persistence.countUserIdsWithAccounts(startDate, endDate);
        logger('User count:', userCount);
        logger('Query stub called with:', queryStub.getCall(0).args)

    });

    it('Fetches user count where include no save is set to true', async () => {
        const startDate = moment();
        const endDate = moment();

        // with args
        queryStub.resolves([{ 'count': 5000000 }]);

        const userCount = await persistence.countUserIdsWithAccounts(startDate, endDate, true);
        logger('User count:', userCount);
    });

    it('Fetches a users pending transactions', async () => {
        const testUserId = uuid();
        const startDate = moment()

        queryStub.resolves(expectedPendingTx);

        const pendingTransactions = await persistence.fetchUserPendingTransactions(testUserId, startDate);
        logger('Result of pending transaction extraction:', pendingTransactions);
    });

    it('Expires hanging transactions', async () => {
        updateRecordStub.resolves({ rows: [
            {'transaction_id': uuid(), 'creation_time': moment().format() },
            {'transaction_id': uuid(), 'creation_time': moment().format() }
        ]});

        const resultOfUpdate = await persistence.expireHangingTransactions();
        logger('Result of hanging transactions update:', resultOfUpdate);
    });
});



