process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:save:test');
const config = require('config');
const moment = require('moment-timezone');

const chai = require('chai');
const expect = chai.expect;
const testHelper = require('./test.helper');

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const multiTableStub = sinon.stub();

class MockRdsConnection {
    constructor (any) {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.largeMultiTableInsert = multiTableStub;
    }
}

const rds = proxyquire('../persistence/rds', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => {
    queryStub.reset();
    insertStub.reset();
    multiTableStub.reset();
};

const expectNoCalls = (stubList) => stubList.forEach((stub) => expect(stub).to.not.have.been.called);

const testFloatId = 'zar_cash_float';
const testClientId = 'pluto_savings_za';
const testPaymentRef = uuid();
const testAccountId = uuid();

describe('*** USER ACTIVITY *** UNIT TEST RDS *** : Fetch floats and find transactions', () => {
    
    beforeEach(resetStubs);

    it('Obtain a default float id and client id', async () => {
        const testAccountId = uuid();
        const queryString = 'select default_float_id, responsible_client_id from account_data.core_account_ledger where account_id = $1';
        queryStub.withArgs(queryString, sinon.match([testAccountId])).resolves([{ 
            'default_float_id': testFloatId,
            'responsible_client_id': testClientId 
        }]);
        const floatResult = await rds.findClientAndFloatForAccount(testAccountId);
        expect(floatResult).to.exist;
        expect(floatResult).to.deep.equal({ clientId: testClientId, floatId: testFloatId });
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, sinon.match([testAccountId]));
        expectNoCalls([insertStub, multiTableStub]);
    });

    it('Find a prior matching transaction, by account ID and amount', async () => {
        const testAccountId = uuid();
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
        const testAccountId = uuid();
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

    it('Call up a transaction via payment ref', async () => {

    });
    
});

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Insert transaction alone and with float', () => {

    before(() => resetStubs());

    const testSaveAmount = 1050000;

    const insertAccountTxQuery = `insert into ${config.get('tables.accountTransactions')} (transaction_id, transaction_type, account_id, currency, unit, ` +
        `amount, float_id, client_id, settlement_status, initiation_time, settlement_time, payment_reference, float_adjust_tx_id, float_alloc_tx_id) values %L returning transaction_id, creation_time`;
    const insertFloatTxQuery = `insert into ${config.get('tables.floatTransactions')} (transaction_id, client_id, float_id, t_type, ` +
        `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;

    const accountColumnKeys = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' +
        '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}, ${settlementTime}, ${paymentRef}, ${floatAddTransactionId}, ${floatAllocTransactionId}';
    const floatColumnKeys = '${floatTransactionId}, ${clientId}, ${floatId}, ${transactionType}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' + 
        '${allocatedToType}, ${allocatedToId}, *{USER_SAVING_EVENT}, ${accountTransactionId}';

    it('Insert a settled save with float id, payment ref, etc., performing matching sides', async () => {
        const testAcTxId = sinon.match.string;
        const testFlTxAddId = sinon.match.string;
        const testFlTxAllocId = sinon.match.string;

        const testInitiationTime = moment().subtract(5, 'minutes');
        const testSettlementTime = moment();

        const expectedRowItem = {
            accountTransactionId: testAcTxId,
            accountId: testAccountId,
            savedCurrency: 'ZAR',
            savedUnit: 'HUNDREDTH_CENT',
            savedAmount: testSaveAmount,
            floatId: testFloatId,
            clientId: testClientId,
            settlementStatus: 'SETTLED',
            initiationTime: testInitiationTime.format(),
            settlementTime: testSettlementTime.format()
        };

        const expectedAccountRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedAccountRow.accountTransactionId = testAcTxId;
        expectedAccountRow.paymentRef = testPaymentRef;
        expectedAccountRow.floatAddTransactionId = testFlTxAddId;
        expectedAccountRow.floatAllocTransactionId = testFlTxAllocId;
        
        const expectedAccountQueryDef = { 
            query: insertAccountTxQuery,
            columnTemplate: accountColumnKeys,
            rows: sinon.match([expectedAccountRow])
        };

        const expectedFloatAdditionRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedFloatAdditionRow.accountTransactionId = testAcTxId;
        expectedFloatAdditionRow.floatTransactionId = testFlTxAddId;
        expectedFloatAdditionRow.transactionType = 'SAVING';
        expectedFloatAdditionRow.allocatedToType = 'FLOAT_ITSELF';
        expectedFloatAdditionRow.allocatedToId = testFloatId;

        const expectedFloatAllocationRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedFloatAllocationRow.accountTransactionId = testAcTxId;
        expectedFloatAllocationRow.floatTransactionId = testFlTxAllocId;
        expectedFloatAllocationRow.transactionType = 'ALLOCATION';
        expectedFloatAllocationRow.allocatedToType = 'END_USER_ACCOUNT';
        expectedFloatAllocationRow.allocatedToId = testAccountId;

        const floatRows = sinon.match([sinon.match(expectedFloatAdditionRow), sinon.match(expectedFloatAllocationRow)]);
        const expectedFloatQueryDef = { 
            query: insertFloatTxQuery,
            columnTemplate: floatColumnKeys,
            rows: floatRows
        };
        
        const expectedArgs = sinon.match([expectedAccountQueryDef, expectedFloatQueryDef]);
        const txDetailsFromRds = [
            { rows: [{ 'transaction_id': uuid(), 'creation_time': moment().format() }] },
            { rows: [{ 'transaction_id': uuid(), 'creation_time': moment().format()}, { 'transaction_id': uuid(), 'creation_time': moment().format() }]}
        ];
        const expectedTxDetails = [{ 
            'accountTransactionId': testAcTxId,
            'creationTimeEpochMillis': sinon.match.number
        }, { 
            'floatAdditionTransactionId': testFlTxAddId,
            'creationTimeEpochMillis': sinon.match.number
        }, {
            'floatAllocationTransactionId': testFlTxAllocId,
            'creationTimeEpochMillis': sinon.match.number
        }];
        
        multiTableStub.withArgs(expectedArgs).resolves(txDetailsFromRds);

        // note: this is test elsewhere and is quite complex so no point repeating here
        queryStub.withArgs(sinon.match.any, [testAccountId, 'ZAR', sinon.match.any]).resolves([{ 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.withArgs(sinon.match.any, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.any]).resolves([{ 'sum': testSaveAmount }]);
        
        const testSettledArgs = { 
            accountId: testAccountId,
            savedCurrency: 'ZAR',
            savedUnit: 'HUNDREDTH_CENT',
            savedAmount: testSaveAmount, 
            floatId: testFloatId,
            clientId: testClientId,
            initiationTime: testInitiationTime,
            settlementTime: testSettlementTime,
            paymentRef: testPaymentRef,
            settlementStatus: 'SETTLED'
        };

        const resultOfSaveInsertion = await rds.addSavingToTransactions(testSettledArgs);

        expect(resultOfSaveInsertion).to.exist;
        expect(resultOfSaveInsertion).to.have.property('transactionDetails');
        expect(resultOfSaveInsertion.transactionDetails).to.be.an('array').that.has.length(3);
        expect(sinon.match(expectedTxDetails[0]).test(resultOfSaveInsertion.transactionDetails[0])).to.be.true;
        expect(sinon.match(expectedTxDetails[1]).test(resultOfSaveInsertion.transactionDetails[1])).to.be.true;
        expect(sinon.match(expectedTxDetails[2]).test(resultOfSaveInsertion.transactionDetails[2])).to.be.true;

        expect(resultOfSaveInsertion).to.have.property('newBalance');
        expect(resultOfSaveInsertion.newBalance).to.deep.equal({ amount: testSaveAmount, unit: 'HUNDREDTH_CENT' });

        expect(multiTableStub).to.have.been.calledOnceWithExactly(expectedArgs);
        expect(queryStub).to.have.been.calledTwice;
        expectNoCalls([insertStub]);
    });

    it('Throw an error if state is SETTLED but no float id', () => {

    });

    it('Insert a pending state save, if no float id', () => {

    });

    it('Update transaction to settled on instruction', () => {

    });

    it('Throws errors if missing necessary arguments (times, etc)', () => {

    });

});

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Sums balances', () => {

    const testUserId1 = uuid();

    const testUserId2 = uuid();
    const testAccoundIdsMulti = [uuid(), uuid(),uuid()];

    const testBalance = Math.floor(100 * 100 * 100 * Math.random());

    beforeEach(() => resetStubs());

    it('Obtain the balance of an account at a point in time correctly', async () => {
        const txTable = config.get('tables.accountTransactions');
        const transTypes = `('USER_SAVING_EVENT','ACCRUAL','CAPITALIZATION','WITHDRAWAL')`;
        const unitQuery = `select distinct(unit) from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` + 
            `and creation_time < to_timestamp($3)`;
        const sumQuery = `select sum(amount) from ${txTable} where account_id = $1 and currency = $2 and unit = $3 and settlement_status = 'SETTLED' ` +
            `and creation_time < to_timestamp($4) and transaction_type in ${transTypes}`;
        
        const testTime = moment();
        const unitQueryArgs = sinon.match([testAccountId, 'USD', testTime.unix()]);
        logger('Test time value of: ', testTime.valueOf());
        queryStub.withArgs(unitQuery, unitQueryArgs).resolves([{ 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.withArgs(sumQuery, [testAccountId, 'USD', 'HUNDREDTH_CENT', testTime.unix()]).resolves([{ 'sum': testBalance }]);
        
        const balanceResult = await rds.sumAccountBalance(testAccountId, 'USD', testTime);
        
        expect(balanceResult).to.exist;
        expect(balanceResult).to.deep.equal({ amount: testBalance, unit: 'HUNDREDTH_CENT' });
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
