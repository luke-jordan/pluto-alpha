process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:save:test');
const config = require('config');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');

var queryStub = sinon.stub();
var insertStub = sinon.stub();
var multiTableStub = sinon.stub();

class MockRdsConnection {
    constructor(any) {
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

const expectNoCalls = ([stubList]) => stubList.forEach(stub => expect(stub).to.not.have.been.called);

const testFloatId = 'zar_cash_float';
const testClientId = 'pluto_savings_za';
const testAccountId = uuid();

describe('Fetch floats and find transactions', () => {
    
    before(resetStubs);

    it('Obtain a default float id', async () => {
        const testAccountId = uuid();
        const queryString = 'select default_float_id from account_data.core_account_ledger where account_id = $1';
        queryStub.withArgs(queryString, [testAccountId]).resolves({ 'default_float_id': testFloatId });
        const floatResult = await rds.findFloatForAccount(testAccountId);
        expect(floatResult).to.exist;
        expect(floatResult).to.deep.equal({ floatId: testFloatId });
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, sinon.match([testAccountId]));
        expectNoCalls([insertStub, multiTableStub]);
    });

    it('Find a prior matching transaction, by account ID and amount', async () => {
        const testAccountId = uuid();
        const testAmount = 100;
        // cut off time should be a configurable thing
        const cutOffTime = Date.now() - (30 * 24 * 60 * 60 * 1000); 
        const queryString = 'select transaction_id from account_data.core_account_ledger where account_id = $1 and amount = $2 and ' 
            + 'currency = $3 and unit = $4 and creation_time > $5';
        const queryParams = sinon.match([testAccountId, testAmount, 'ZAR', 'HUNDREDTH_CENT', cutOffTime]);
        
        const testMatchingTxId = uuid();
        queryStub.withArgs(queryString, queryParams).resolves([{ 'transaction_id': testMatchingTxId }]);
        
        const findResult = await rds.findMatchingTransaction({ accountId: testAccountId, amount: testAmount, currency: 'ZAR', unit: 'HUNDREDTH_CENT'});
        expect(findResult).to.exist;
        expect(findResult).to.deep.equal({ transactionId: testMatchingTxId });
        expect(queryStub).to.have.been.calledOnceWithExactly(queryString, queryParams);
        expectNoCalls(insertStub, multiTableStub);
    });

    it('Fail to find a prior matching transaction', async () => {
        const testAccountId = uuid();
        const queryString = 'select transaction_id from account_data.core_account_ledger where account_id = $1 and amount = $2 and '
            + 'currency = $3 and unit = $4 and creation_time > 5';
        const queryParams = sinon.match([testAccountId, 101, 'ZAR', 'HUNDREDTH_CENT', Date.now() - 24 * 60 * 60 * 1000]);
        queryParams.withArgs(queryString, queryParams).resolves([{}]);

        const findResult = await rds.findMatchingTransaction({ accountId: testAccountId, amount: 101, currency: 'ZAR', unit: 'HUNDREDTH_CENT' });
        expect(findResult).to.exist;
        expect(findResult).to.deep.equal({});
        expect(queryString).to.have.been.calledOnceWithExactly(queryString, queryParams);
        expectNoCalls(insertStub, multiTableStub);
    });
    
});

describe('Insert transaction alone and with float', () => {

    before(() => resetStubs());

    const insertAccountTxQuery = `insert into ${config.get('tables.accountTransactions')} (transaction_id, transaction_type, account_id, currency, unit, `
        + `amount, float_id, matching_float_tx_id, settlement_status) values %L returning transaction_id, creation_time`;
    const insertFloatTxQuery = `insert into ${config.get('tables.floatTransactions')} (transaction_id, client_id, float_id, t_type, ` +
        `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;

    const accountColumnKeys = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' +
        '${floatId}, ${floatTransactionId}, ${settlementStatus}';
    const floatColumnKeys = '${floatTransactionId}, ${clientId}, ${floatId}, ${transactionType}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' + 
        '${allocatedToType}, ${allocatedToId}, *{USER_SAVING_EVENT}, ${accountTransactionId}';

    it('Insert a save with float id, performing matching sides', async () => {
        const testAcTxId = sinon.match.any;
        const testFlTxId = sinon.match.any;
        const expectedRowItem = ({
            accountTransactionId: testAcTxId,
            floatTransactionId: testFlTxId,
            accountId: testAccountId,
            savedCurrency: 'ZAR',
            savedUnit: 'HUNDREDTH_CENT',
            savedAmount: 105,
            floatId: testFloatId,
            settlementStatus: 'SETTLED'
        });

        const expectedFloatAdditionRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedFloatAdditionRow.accountTransactionId = testAcTxId;
        expectedFloatAdditionRow.floatTransactionId = testFlTxId;
        expectedFloatAdditionRow.transactionType = 'SAVING';
        expectedFloatAdditionRow.allocatedToType = 'FLOAT_ITSELF';
        expectedFloatAdditionRow.allocatedToId = testFloatId;

        const expectedFloatAllocationRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedFloatAllocationRow.accountTransactionId = testAcTxId;
        expectedFloatAllocationRow.floatTransactionId = testFlTxId;
        expectedFloatAllocationRow.transactionType = 'ALLOCATION';
        expectedFloatAllocationRow.allocatedToType = 'END_USER_ACCOUNT';
        expectedFloatAllocationRow.allocatedToId = testAccountId;

        const expectedAccountQueryDef = { query: insertAccountTxQuery, columnTemplate: accountColumnKeys, rows: sinon.match([expectedRowItem])};
        const expectedFloatQueryDef = { query: insertFloatTxQuery, columnTemplate: floatColumnKeys, rows: sinon.match([expectedFloatAdditionRow, expectedFloatAllocationRow])};
        
        const expectedArgs = sinon.match([expectedAccountQueryDef, expectedFloatQueryDef]);
        const expectedTxDetails = [{ 'transaction_id': testAcTxId, 'creation_time': new Date() }, { 'transaction_id': testFlTxId, 'creation_time': new Date()}]; 
        
        multiTableStub.withArgs(expectedArgs).resolves(expectedTxDetails);

        const balanceQuery = `select sum(amount) from ${config.get('tables.accountTransactions')} where account_id = $1 and currency = $2`;
        queryStub.withArgs(balanceQuery, [testAccountId, 'ZAR']).resolves([{ 'sum': '105' }]);
        
        const testSettledArgs = { accountId: testAccountId, savedCurrency: 'ZAR', savedUnit: 'HUNDREDTH_CENT', savedAmount: 105, 
            floatId: testFloatId, settlementTime: new Date() };

        const resultOfSaveInsertion = await rds.addSavingToTransactions(testSettledArgs);

        const calledArgs = multiTableStub.getCall(0).args[0][1];
        
        expect(resultOfSaveInsertion).to.exist;
        expect(resultOfSaveInsertion).to.deep.equal({ newBalance: 105, transactionDetails: expectedTxDetails });
        expect(multiTableStub).to.have.been.calledOnceWithExactly(expectedArgs);
        expect(queryStub).to.have.been.calledOnceWithExactly(balanceQuery, [testAccountId, 'ZAR']);
        // expectNoCalls(insertStub);
    });

    it('Throw an error if state is SETTLED but no float id', () => {

    });

    it('Insert a pending state save, if no float id', () => {

    });

    it('Update transaction to settled on instruction', () => {

    });

});

describe('Sums balances', () => {

    before(() => resetStubs());

});