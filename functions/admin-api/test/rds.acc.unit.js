'use strict';

const logger = require('debug')('jupiter:admin:rds-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');
const camelCaseKeys = require('camelcase-keys');

const queryStub = sinon.stub();
const updateRecordStub = sinon.stub();
const insertRecordsStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.updateRecord = updateRecordStub;
        this.insertRecords = insertRecordsStub;
    }
}

const persistence = proxyquire('../persistence/rds.account', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
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
        const multiplier = MAX_USERS - MIN_USERS;
        const normalizer = MIN_USERS;
        const rawResult = base * multiplier;
        return rawResult + normalizer;
    };

    beforeEach(() => {
        helper.resetStubs(queryStub, updateRecordStub, insertRecordsStub);
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
            { 'transaction_id': testTransactionId, 'creation_time': testCreationTime },
            { 'transaction_id': testTransactionId, 'creation_time': testCreationTime }            
        ]});

        const expectedResult = { transactionId: testTransactionId, creationTime: testCreationTime };

        const resultOfUpdate = await persistence.expireHangingTransactions();
        logger('Result of hanging transactions update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([expectedResult, expectedResult]);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(expectedUpdateQuery, expectedValues);
    });

    it('Expires boosts', async () => {
        const testBoostId = uuid();
        const testAccountId = uuid();

        const boostMasterTable = config.get('tables.boostMasterTable');
        const boostJoinTable = config.get('tables.boostJoinTable');

        const firstUpdateQuery = 'update boost_data.boost set active = $1 where active = true and end_time < current_timestamp returning boost_id';
        const secondUpdateQuery = `update ${boostJoinTable} set boost_status = $1 where boost_status not in ($2, $3, $4) and ` +
            `boost_id in (select boost_id from ${boostMasterTable} where active = $5) returning boost_id, account_id`;
        const updateValues = ['EXPIRED', 'REDEEMED', 'REVOKED', 'EXPIRED', false];

        updateRecordStub.onFirstCall().resolves({
            'rows': [
                { 'boost_id': testBoostId },
                { 'boost_id': testBoostId },
                { 'boost_id': testBoostId }
            ],
            rowCount: 3
        });

        updateRecordStub.resolves({ 'rows': [
            { 'boost_id': testBoostId, 'account_id': testAccountId },
            { 'boost_id': testBoostId, 'account_id': testAccountId },
            { 'boost_id': testBoostId, 'account_id': testAccountId }
        ]});

        const expectedRow = { boostId: testBoostId, accountId: testAccountId };

        const resultOfUpdate = await persistence.expireBoosts();
        logger('Result of boost cull:', resultOfUpdate);
        logger('Args:', updateRecordStub.getCall(1).args);
       
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([expectedRow, expectedRow, expectedRow]);
        expect(updateRecordStub).to.have.been.calledTwice;
        expect(updateRecordStub).to.to.have.been.calledWith(firstUpdateQuery, [false]);
        expect(updateRecordStub).to.to.have.been.calledWith(secondUpdateQuery, updateValues);
    });

    it('Boost culling exits where no boost found for update', async () => {
        const updateQuery = 'update boost_data.boost set active = $1 where active = true and end_time < current_timestamp returning boost_id';
        updateRecordStub.onFirstCall().resolves({ rows: [], rowCount: 0 });

        const resultOfUpdate = await persistence.expireBoosts();
        logger('Result of boost cull:', resultOfUpdate);
       
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([]);
        expect(updateRecordStub).to.to.have.been.calledOnceWithExactly(updateQuery, [false]);
    });

    it('Fetches IDs for accounts', async () => {
        const testUserId = uuid();
        const firstAccountId = uuid();
        const secondAccountId = uuid();
        const thirdAccountId = uuid();

        const accountIds = [firstAccountId, secondAccountId, thirdAccountId];

        const selectQuery = 'select account_id, owner_user_id from account_data.core_account_ledger where account_id in ($1, $2, $3)';

        queryStub.resolves([
            { 'account_id': firstAccountId, 'owner_user_id': testUserId },
            { 'account_id': secondAccountId, 'owner_user_id': testUserId },
            { 'account_id': thirdAccountId, 'owner_user_id': testUserId }
        ]);

        const expectedResult = {
            [firstAccountId]: testUserId,
            [secondAccountId]: testUserId,
            [thirdAccountId]: testUserId
        };

        const fetchResult = await persistence.fetchUserIdsForAccounts(accountIds);
        logger('Result of id extractions:', fetchResult);
        
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, accountIds);
    });

    it('Adjusts transaction status', async () => {
        const testUpdatedTime = moment().format();

        const testTransactionId = uuid();
        const testAdminId = uuid();
        const testUserId = uuid();

        const updateQuery = 'update transaction_data.core_transaction_ledger set settlement_status = $1 where transaction_id = $2 returning settlement_status, updated_time';
        const updateValues = ['SETTLED', testTransactionId];

        updateRecordStub.resolves({ rows: [{ 'settlement_status': 'SETTLED', 'updated_time': testUpdatedTime }] });

        const expectedResult = { settlementStatus: 'SETTLED', updatedTime: testUpdatedTime };

        const params = {
            transactionId: testTransactionId,
            newTxStatus: 'SETTLED',
            logContext: {
                performedBy: testAdminId,
                owningUserId: testUserId,
                reason: 'Saving event completed',
                newStatus: 'SETTLED'
            }
        };

        const resultOfUpdate = await persistence.adjustTxStatus(params);
        logger('Result of transaction update:', resultOfUpdate);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(updateQuery, updateValues);
    });

    it('Inserts account log', async () => {
        const testCreationTime = moment().format();

        const testTransactionId = uuid();
        const testAccountId = uuid();
        const testAdminId = uuid();
        const testUserId = uuid();

        const insertQuery = 'insert into account_data.account_log (log_id, creating_user_id, account_id, transaction_id, log_type, log_context) values %L returning creation_time';
        const insertColumns = '${logId}, ${creatingUserId}, ${accountId}, ${transactionId}, ${logType}, ${logContext}';

        const logObject = {
            logId: sinon.match.string,
            creatingUserId: testAdminId,
            accountId: testAccountId,
            transactionId: testTransactionId,
            logType: 'ADMIN_UPDATED_TX',
            logContext: {
                performedBy: testAdminId,
                owningUserId: testUserId,
                reason: 'Saving event completed',
                newStatus: 'SETTLED'
            }
        };

        insertRecordsStub.resolves({ 'creation_time': testCreationTime });

        const params = {
            transactionId: testTransactionId,
            accountId: testAccountId,
            adminUserId: testAdminId,
            logType: 'ADMIN_UPDATED_TX',
            logContext: {
                performedBy: testAdminId,
                owningUserId: testUserId,
                reason: 'Saving event completed',
                newStatus: 'SETTLED'
            }
        };

        const resultOfInsert = await persistence.insertAccountLog(params);
        logger('Result of account log insertion:', resultOfInsert);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ 'creation_time': testCreationTime }); // no camelization
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(insertQuery, insertColumns, [logObject]);
    });

    it('Account log insertion fetches relevent account id where not provided in parameters', async () => {
        const testCreationTime = moment().format();

        const testTransactionId = uuid();
        const testAccountId = uuid();
        const testAdminId = uuid();
        const testUserId = uuid();

        const allowedColumns = 'transaction_id, account_id, creation_time, updated_time, transaction_type, settlement_status, settlement_time, client_id, float_id, amount, currency, unit, human_reference, tags, flags';
        const selectQuery = `select ${allowedColumns} from transaction_data.core_transaction_ledger where transaction_id = $1`; 
        const insertQuery = 'insert into account_data.account_log (log_id, creating_user_id, account_id, transaction_id, log_type, log_context) values %L returning creation_time';
        const insertColumns = '${logId}, ${creatingUserId}, ${accountId}, ${transactionId}, ${logType}, ${logContext}';

        const logObject = {
            logId: sinon.match.string,
            creatingUserId: testAdminId,
            accountId: testAccountId,
            transactionId: testTransactionId,
            logType: 'ADMIN_UPDATED_TX',
            logContext: {
                performedBy: testAdminId,
                owningUserId: testUserId,
                reason: 'Saving event completed',
                newStatus: 'SETTLED'
            }
        };

        insertRecordsStub.resolves({ 'creation_time': testCreationTime });
        queryStub.resolves([{ 'account_id': testAccountId }]);

        const params = {
            transactionId: testTransactionId,
            adminUserId: testAdminId,
            logType: 'ADMIN_UPDATED_TX',
            logContext: {
                performedBy: testAdminId,
                owningUserId: testUserId,
                reason: 'Saving event completed',
                newStatus: 'SETTLED'
            }
        };

        const resultOfInsert = await persistence.insertAccountLog(params);
        logger('Result of account log insertion:', resultOfInsert);
        
        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ 'creation_time': testCreationTime }); // no camelization
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(insertQuery, insertColumns, [logObject]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testTransactionId]);
    });

    it('Finds user from reference', async () => {

        const testUserId = uuid();

        const params = {
            searchValue: 'TEST_VALUE',
            bsheetPrefix: 'TEST_PREFIX'
        };

        const firstQuery = 'select owner_user_id from account_data.core_account_ledger where human_ref = $1'; // TEST_VALUE
        const secondQuery = 'select owner_user_id from account_data.core_account_ledger where $1 = any(tags)'; // 'TEST_PREFIX::TEST_VALUE'
        const thirdQuery = `select owner_user_id from ${config.get('tables.accountTable')} inner join ${config.get('tables.transactionTable')} ` +
            `on ${config.get('tables.accountTable')}.account_id = ${config.get('tables.transactionTable')}.account_id ` +
            `where ${config.get('tables.transactionTable')}.human_reference = $1`; // 1

        queryStub.onFirstCall().resolves([{ 'owner_user_id': testUserId }]);

        const resultOfFirstSearch = await persistence.findUserFromRef(params);
        expect(resultOfFirstSearch).to.deep.equal(testUserId);
        expect(queryStub).to.have.been.calledOnceWithExactly(firstQuery, ['TEST_VALUE']);
        queryStub.reset();

        queryStub.resolves([]);
        queryStub.onSecondCall().resolves([{ 'owner_user_id': testUserId }]);
        const resultOfSecondSearch = await persistence.findUserFromRef(params);
        expect(resultOfSecondSearch).to.deep.equal(testUserId);
        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWith(secondQuery, ['TEST_PREFIX::TEST_VALUE']);

        queryStub.reset();

        queryStub.resolves([]);
        queryStub.onThirdCall().resolves([{ 'owner_user_id': testUserId }]);
        const resultOfThirdSearch = await persistence.findUserFromRef(params);
        expect(resultOfThirdSearch).to.deep.equal(testUserId);
        expect(queryStub).to.have.been.calledThrice;
        expect(queryStub).to.have.been.calledWith(thirdQuery, ['TEST_VALUE']);
        queryStub.reset();

        queryStub.resolves([]);
        const fallbackResult = await persistence.findUserFromRef(params);
        expect(fallbackResult).to.be.null;

    });

    it('Finds balance sheet tag', async () => {

        const testAccountId = uuid();

        const params = { accountId: testAccountId, tagPrefix: 'TEST_PREFIX' };

        const selectQuery = `select tags from ${config.get('tables.accountTable')} where account_id = $1`;

        queryStub.resolves([{ 'tags': ['TEST_PREFIX::TEST_TARGET', 'ACCRUAL_EVENT::901e211d-d7a1-4991-88ed-d2230c226fbd']}]);

        const fetchResult = await persistence.fetchBsheetTag(params);
        expect(fetchResult).to.deep.equal('TEST_TARGET');
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
        queryStub.reset();

        queryStub.resolves([{ 'tags': ['ACCRUAL_EVENT::901e211d-d7a1-4991-88ed-d2230c226fbd']}]);

        const resultOnMissingTargetTag = await persistence.fetchBsheetTag(params);
        expect(resultOnMissingTargetTag).to.be.null;
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
        queryStub.reset();

        queryStub.resolves([{ 'tags': []}]);

        const resultOnNoTags = await persistence.fetchBsheetTag(params);
        expect(resultOnNoTags).to.be.null;
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
        queryStub.reset();

    });

    it('Updates balance sheet tag', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();

        const selectQuery = 'select tags from account_data.core_account_ledger where account_id = $1';
        const updateQuery = 'update account_data.core_account_ledger set tags = array_append(tags, $1) where account_id = $2 returning owner_user_id, tags';
        const updateValues = ['TEST_PREFIX::NEW_IDENTIFIER', testAccountId];


        const expectedResult = {
            ownerUserId: testUserId,
            tags: ['TEST_PREFIX::NEW_IDENTIFIER'],
            oldIdentifier: null
        };

        const params = {
            accountId: testAccountId,
            tagPrefix: 'TEST_PREFIX',
            newIdentifier: 'NEW_IDENTIFIER'
        };

        queryStub.resolves([{ 'tags': []}]);
        updateRecordStub.resolves({ rows: [{ 'owner_user_id': testUserId, 'tags': ['TEST_PREFIX::NEW_IDENTIFIER']}]});

        const resultOfUpdate = await persistence.updateBsheetTag(params);
        logger('Result of balance sheet update:', resultOfUpdate);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
        expect(updateRecordStub).to.have.been.calledWith(updateQuery, updateValues);
    });

    it('Balance sheet tag update replaces old identifier with new', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();

        const selectQuery = 'select tags from account_data.core_account_ledger where account_id = $1';
        const updateQuery = 'update account_data.core_account_ledger set tags = array_replace(tags, $1, $2) where account_id = $3 returning owner_user_id, tags';
        const updateValues = ['TEST_PREFIX::OLD_IDENTIFIER', 'TEST_PREFIX::NEW_IDENTIFIER', testAccountId];

        const expectedResult = {
            ownerUserId: testUserId,
            tags: ['TEST_PREFIX::NEW_IDENTIFIER'],
            oldIdentifier: 'OLD_IDENTIFIER'
        };

        const params = {
            accountId: testAccountId,
            tagPrefix: 'TEST_PREFIX',
            newIdentifier: 'NEW_IDENTIFIER'
        };

        queryStub.resolves([{ 'tags': ['TEST_PREFIX::OLD_IDENTIFIER']}]);
        updateRecordStub.resolves({ rows: [{ 'owner_user_id': testUserId, 'tags': ['TEST_PREFIX::NEW_IDENTIFIER']}]});

        const resultOfUpdate = await persistence.updateBsheetTag(params);
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
        expect(updateRecordStub).to.have.been.calledWith(updateQuery, updateValues);
    });

    it('Balance sheet tag update returns null on update failure', async () => {
        const testAccountId = uuid();

        const selectQuery = 'select tags from account_data.core_account_ledger where account_id = $1';
        const updateQuery = 'update account_data.core_account_ledger set tags = array_replace(tags, $1, $2) where account_id = $3 returning owner_user_id, tags';
        const updateValues = ['TEST_PREFIX::OLD_IDENTIFIER', 'TEST_PREFIX::NEW_IDENTIFIER', testAccountId];

        const params = {
            accountId: testAccountId,
            tagPrefix: 'TEST_PREFIX',
            newIdentifier: 'NEW_IDENTIFIER'
        };

        queryStub.resolves([{ 'tags': ['TEST_PREFIX::OLD_IDENTIFIER']}]);
        updateRecordStub.resolves();

        const resultOfUpdate = await persistence.updateBsheetTag(params);
        logger('Result of balance sheet update:', resultOfUpdate);
        
        expect(resultOfUpdate).to.be.null;
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
        expect(updateRecordStub).to.have.been.calledWith(updateQuery, updateValues);
    });

});
