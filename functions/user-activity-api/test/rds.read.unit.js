'use strict';

// const logger = require('debug')('jupiter:activity-rds:test');
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

    it('Obtain basic info on user account', async () => {
        const queryString = 'select owner_user_id, default_float_id, responsible_client_id, frozen from account_data.core_account_ledger where account_id = $1';
        queryStub.withArgs(queryString, sinon.match([testAccountId])).resolves([{ 
            'default_float_id': testFloatId,
            'responsible_client_id': testClientId,
            'owner_user_id': testUserId,
            'frozen': false
        }]);
        const floatResult = await rds.getOwnerInfoForAccount(testAccountId);
        expect(floatResult).to.exist;
        expect(floatResult).to.deep.equal({ clientId: testClientId, floatId: testFloatId, systemWideUserId: testUserId, frozen: false });
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, sinon.match([testAccountId]));
        expectNoCalls([insertStub, multiTableStub]);
    });

    // it('Call up a transaction via payment ref', async () => { });
    
});

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Sums balances', () => {

    const testUserId1 = uuid();

    const testUserId2 = uuid();
    const testAccountIdsMulti = [uuid(), uuid(), uuid()];

    const testBalance = Math.floor(100 * 100 * 100 * Math.random());
    const testBalanceCents = Math.round(testBalance);

    const txTable = config.get('tables.accountTransactions');
    const transTypes = ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION', 'BOOST_REVOCATION'];
    const sumQuery = 'select sum(amount), unit from transaction_data.core_transaction_ledger where account_id = $1 and ' +
        'currency = $2 and settlement_status in ($3, $4, $5) and settlement_time < to_timestamp($6) and ' +
        'transaction_type in ($7, $8, $9, $10, $11, $12) group by unit';
    // on this one we leave out the accrued
    const latestTxQuery = `select creation_time from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` +
        `and creation_time < to_timestamp($3) order by creation_time desc limit 1`;

    beforeEach(() => resetStubs());

    it('Obtain the balance of an account at a point in time correctly', async () => {
        const testTime = moment();
        const testLastTxTime = moment().subtract(5, 'hours');
        const queryArgs = [testAccountId, 'USD', 'SETTLED', 'ACCRUED', 'LOCKED', testTime.unix(), ...transTypes];
                
        queryStub.onFirstCall().resolves([
            { 'unit': 'HUNDREDTH_CENT', 'sum': testBalance }, { 'unit': 'WHOLE_CENT', 'sum': testBalanceCents }
        ]);
        queryStub.onSecondCall().resolves([{ 'creation_time': testLastTxTime.format() }]);

        const expectedBalance = testBalance + (100 * testBalanceCents);
        
        const balanceResult = await rds.sumAccountBalance(testAccountId, 'USD', testTime);

        expect(balanceResult).to.exist;
        expect(balanceResult).to.have.property('amount', expectedBalance);
        expect(balanceResult).to.have.property('unit', 'HUNDREDTH_CENT');
        expect(balanceResult.lastTxTime.format()).to.equal(testLastTxTime.format());

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(sumQuery, queryArgs);
        expect(queryStub).to.have.been.calledWithExactly(latestTxQuery, [testAccountId, 'USD', testTime.unix()]);
    });

    it('Handle case of no prior transactions properly', async () => {
        const testTime = moment();
        const queryArgs = [testAccountId, 'USD', 'SETTLED', 'ACCRUED', 'LOCKED', testTime.unix(), ...transTypes];

        queryStub.onFirstCall().resolves([]);
        queryStub.onSecondCall().resolves([]);
        
        const balanceResult = await rds.sumAccountBalance(testAccountId, 'USD', testTime);
        
        expect(balanceResult).to.exist;
        expect(balanceResult).to.deep.equal({ amount: 0, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(sumQuery, queryArgs);
        expect(queryStub).to.have.been.calledWithExactly(latestTxQuery, [testAccountId, 'USD', testTime.unix()]);
    });

    it('Fetches balance available for withdrawals', async () => {
        const testTime = moment();

        queryStub.onFirstCall().resolves([{ 'unit': 'HUNDREDTH_CENT', 'sum': 40000 }, { 'unit': 'WHOLE_CENT', 'sum': 40000 }]);
        queryStub.onSecondCall().resolves([{ 'unit': 'HUNDREDTH_CENT', 'sum': -1000 }, { 'unit': 'WHOLE_CENT', 'sum': -1000 }]);

        const balanceResult = await rds.calculateWithdrawalBalance(testAccountId, 'USD', testTime);
        expect(balanceResult).to.exist;
        expect(balanceResult).to.deep.equal({ amount: 3939000, unit: 'HUNDREDTH_CENT', currency: 'USD' });

        const expectedTxTypes = ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'];

        const expectedBalanceQuery = 'select sum(amount), unit from transaction_data.core_transaction_ledger where account_id = $1 and ' +
            'currency = $2 and settlement_status in ($3, $4) and settlement_time < to_timestamp($5) and ' +
            'transaction_type in ($6, $7, $8, $9, $10) group by unit';

        const expectedWithdrawalsQuery = 'select sum(amount), unit from transaction_data.core_transaction_ledger where account_id = $1 and ' +
            'currency = $2 and settlement_status = $3 and transaction_type = $4 group by unit';

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(expectedBalanceQuery, [testAccountId, 'USD', 'SETTLED', 'ACCRUED', testTime.unix(), ...expectedTxTypes]);
        expect(queryStub).to.have.been.calledWithExactly(expectedWithdrawalsQuery, [testAccountId, 'USD', 'PENDING', 'WIHDRAWAL']);
    });

    it('Find an account ID for a user ID, single and multiple', async () => {
        // most recent account first
        const findQuery = 'select account_id from account_data.core_account_ledger where owner_user_id = $1 order by creation_time desc';
        queryStub.withArgs(findQuery, [testUserId1]).resolves([{ 'account_id': testAccountId }]);
        const multiAccountList = testAccountIdsMulti.map((accountId) => ({ 'account_id': accountId }));
        queryStub.withArgs(findQuery, [testUserId2]).resolves(multiAccountList);

        const resultOfAccountQuerySingle = await rds.findAccountsForUser(testUserId1);
        expect(resultOfAccountQuerySingle).to.exist;
        expect(resultOfAccountQuerySingle).to.deep.equal([testAccountId]);

        const resultOfAccountQueryMultiple = await rds.findAccountsForUser(testUserId2);
        expect(resultOfAccountQueryMultiple).to.exist;
        expect(resultOfAccountQueryMultiple).to.deep.equal(testAccountIdsMulti);

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
        {'transaction_type': 'USER_SAVING_EVENT', 'amount': '100', 'unit': 'WHOLE_CENT', 'currency': 'USD' },
        {'transaction_type': 'WITHDRAWAL', 'amount': '50', 'unit': 'WHOLE_CURRENCY', 'currency': 'USD' }
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

    it('Fetches logs for transaction', async () => {
        const logQuery = `select * from account_data.account_log where transaction_id = $1`;
        queryStub.withArgs(logQuery, [testTxId]).resolves([{ 'log_id': 'some-log', 'log_type': 'ADMIN_SETTLED_SAVE' }]);
        const result = await rds.fetchLogsForTransaction(testTxId);
        expect(result).to.deep.equal([{ logId: 'some-log', logType: 'ADMIN_SETTLED_SAVE' }]);
    });

    it('Fetches prior transactions', async () => {
        const selectQuery = `select * from ${config.get('tables.accountTransactions')} where account_id = $1 ` +
            `and settlement_status in ($2, $3) and transaction_type in ($4, $5, $6, $7, $8, $9) order by creation_time desc`;
        const selectValues = [testAccountId, 'SETTLED', 'LOCKED', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'BOOST_REDEMPTION', 'CAPITALIZATION', 'BOOST_POOL_FUNDING', 'BOOST_REVOCATION'];

        queryStub.resolves([expectedTxRow, expectedTxRow, expectedTxRow]);
        const priorTxs = await rds.fetchTransactionsForHistory(testAccountId);

        expect(priorTxs).to.exist;
        expect(priorTxs).to.deep.equal([expectedTxRow, expectedTxRow, expectedTxRow].map((row) => camelizeKeys(row)));
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, selectValues);
    });

    it('Fetches pending transactions', async () => {
        const selectQuery = `select * from ${config.get('tables.accountTransactions')} where account_id = $1 ` +
            `and settlement_status = $2 and transaction_type in ($3, $4) order by creation_time desc`;
        const selectValues = [testAccountId, 'PENDING', 'USER_SAVING_EVENT', 'WITHDRAWAL'];

        queryStub.resolves(testPendingTransactions);
        const priorTxs = await rds.fetchPendingTransactions(testAccountId);

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

    it('Fetches human ref & tags properly', async () => {
        const query = `select account_id, human_ref, tags from account_data.core_account_ledger where owner_user_id = $1 ` + 
            `order by creation_time desc limit 1`;
        queryStub.resolves([{ 'human_ref': 'SOMEREF', 'account_id': 'some-id', 'tags': ['some_tag'] }]);
        const result = await rds.findHumanRefForUser(testUserId);
        expect(result).to.deep.equal([{ humanRef: 'SOMEREF', accountId: 'some-id', tags: ['some_tag'] }]);
        expect(queryStub).to.have.been.calledOnceWithExactly(query, [testUserId]);
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

        expect(result).to.exist;
        expect(result).to.deep.equal('POL1');
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId]);
    });

    it('Fetches bank reference information', async () => {
        const accountTable = config.get('tables.accountLedger');
        const txTable = config.get('tables.accountTransactions');

        const selectQuery = `select human_ref, owner_user_id, count(transaction_id) from ${accountTable} left join ${txTable} ` +
            `on ${accountTable}.account_id = ${txTable}.account_id where ${accountTable}.account_id = $1 ` + 
            `and transaction_type in ($2, $3) group by human_ref, owner_user_id`;

        queryStub.resolves([{ 'human_ref': 'BUS123', 'count': 2, 'owner_user_id': testUserId }]);

        const bankRefInfo = await rds.fetchInfoForBankRef(testAccountId);

        expect(bankRefInfo).to.exist;
        expect(bankRefInfo).to.deep.equal({ humanRef: 'BUS123', count: 2, ownerUserId: testUserId });
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testAccountId, 'USER_SAVING_EVENT', 'WITHDRAWAL']);
    });

    it('Checks for duplicate saves', async () => {
        const selectQuery = `select * from ${config.get('tables.accountTransactions')} where account_id = $1 and ` +
            `amount = $2 and currency = $3 and unit = $4 and settlement_status in ($5, $6) and ` +
            `creation_time > $7 order by creation_time desc limit 1`;

        const selectValues = [testAccountId, testSaveAmount, 'ZAR', 'HUNDREDTH_CENT', 'INITIATED', 'PENDING', sinon.match.string];

        queryStub.resolves([expectedTxRow]);

        const params = {
            accountId: testAccountId,
            amount: testSaveAmount,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT'
        };

        const resultOfCheck = await rds.checkForDuplicateSave(params);

        expect(resultOfCheck).to.exist;
        expect(resultOfCheck).to.deep.equal(camelizeKeys(expectedTxRow));
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, selectValues);
    });

});

describe('*** UNIT TEST SAVINGS HEAT PERSISTENCE FUNCTIONS ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches account ids', async () => {
        const selectQuery = `select account_id from ${config.get('tables.accountLedger')} where frozen = $1`;
        queryStub.withArgs(selectQuery, [false]).resolves([
            { 'account_id': testAccountId },
            { 'account_id': testAccountId },
            { 'account_id': testAccountId },
            { 'account_id': testAccountId }
        ]);

        const resultOfFetch = await rds.fetchAccounts();

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([testAccountId, testAccountId, testAccountId, testAccountId]);
    });

    it('Fecthes account ids for float', async () => {
        const selectQuery = `select account_id from ${config.get('tables.accountLedger')} where default_float_id = $1 and frozen = $2`;
        queryStub.withArgs(selectQuery, [testFloatId, false]).resolves([
            { 'account_id': testAccountId },
            { 'account_id': testAccountId },
            { 'account_id': testAccountId },
            { 'account_id': testAccountId }
        ]);

        const resultOfFetch = await rds.findAccountsForFloat(testFloatId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([testAccountId, testAccountId, testAccountId, testAccountId]);
    });

    it('Fetches account ids for client', async () => {
        const selectQuery = `select account_id from ${config.get('tables.accountLedger')} where responsible_client_id = $1 and frozen = $2`;
        queryStub.withArgs(selectQuery, [testClientId, false]).resolves([
            { 'account_id': testAccountId },
            { 'account_id': testAccountId },
            { 'account_id': testAccountId },
            { 'account_id': testAccountId }
        ]);

        const resultOfFetch = await rds.findAccountsForClient(testClientId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([testAccountId, testAccountId, testAccountId, testAccountId]);
    });

    it('Counts number of settled saved in previous month', async () => {
        const selectQuery = `select count(transaction_id) from ${config.get('tables.accountTransactions')} where account_id = $1 and ` +
            `transaction_type = $2 and settlement_status = $3 and creation_time > $4 and creation_time < $5`;
        const selectValues = [testAccountId, 'USER_SAVING_EVENT', 'SETTLED', sinon.match.string, sinon.match.string];

        queryStub.withArgs(selectQuery, selectValues).resolves([{ 'count': 22 }]);
        const resultOfCount = await rds.countSettledSavesForPrevMonth(testAccountId);

        expect(resultOfCount).to.exist;
        expect(resultOfCount).to.deep.equal(22);
    });

    it('Counts a users active saving buddies', async () => {
        const selectQuery = `select count(relationship_id) from ${config.get('tables.friendshipTable')} where initiated_user_id = $1 or accepted_user_id = $2 ` +
            `and relationship_status = $3`;
        const selectValues = [testUserId, testUserId, 'ACTIVE'];

        queryStub.withArgs(selectQuery, selectValues).resolves([{ 'count': 7 }]);
        const resultOfCount = await rds.countActiveSavingFriendsForUser(testUserId);

        expect(resultOfCount).to.exist;
        expect(resultOfCount).to.deep.equal(7);
    });

    it('Compiles list of saving friends with dates', async () => {
        // creation time not updated time to prevent gaming (via off/on)
        const selectQuery = `select relationship_id, initiated_user_id, creation_time from ${config.get('tables.friendshipTable')} where ` +
            `(initiated_user_id = $1 or accepted_user_id = $1) and relationship_status = $2`;
        const selectValues = [testUserId, 'ACTIVE'];

        const mockRelationshipId = uuid();
        const mockCreationTime = moment().subtract(7, 'days');

        const mockFriendship = { 'relationship_id': mockRelationshipId, 'creation_time': mockCreationTime.format(), 'initiated_user_id': testUserId };
        queryStub.withArgs(selectQuery, selectValues).resolves([mockFriendship]);

        const resultOfFetch = await rds.getMinimalFriendListForUser(testUserId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([{ relationshipId: mockRelationshipId, creationTime: moment(mockCreationTime.format()), initiatedUserId: testUserId }]);
    });

    it('Fetches account opened date', async () => {
        const testCreationTime = moment().format();
        const selectQuery = `select creation_time from ${config.get('tables.accountLedger')} where account_id = $1`;
        queryStub.withArgs(selectQuery, [testAccountId]).resolves([{ 'creation_time': testCreationTime }]);

        const resultOfFetch = await rds.getAccountOpenedDateForHeatCalc(testAccountId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(testCreationTime);
    });

});
