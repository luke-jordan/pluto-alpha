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
const testPaymentRef = uuid();
const testAccountId = uuid();

describe('*** USER ACTIVITY *** UNIT TEST RDS *** : Fetch floats and find transactions', () => {
    
    beforeEach(resetStubs);

    it('Obtain a default float id and client id', async () => {
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

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Insert transaction alone and with float', () => {

    beforeEach(() => resetStubs());

    const testSaveAmount = 1050000;

    const insertAccNotSettledTxQuery = `insert into ${config.get('tables.accountTransactions')} (transaction_id, transaction_type, account_id, currency, unit, ` +
        `amount, float_id, client_id, settlement_status, initiation_time) values %L returning transaction_id, creation_time`;
    const insertAccSettledTxQuery = `insert into ${config.get('tables.accountTransactions')} (transaction_id, transaction_type, account_id, currency, unit, ` +
        `amount, float_id, client_id, settlement_status, initiation_time, settlement_time, payment_reference, payment_provider, float_adjust_tx_id, float_alloc_tx_id) values %L returning transaction_id, creation_time`;
    const insertFloatTxQuery = `insert into ${config.get('tables.floatTransactions')} (transaction_id, client_id, float_id, t_type, ` +
        `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;
    
    const accountColKeysNotSettled = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${currency}, ${unit}, ${amount}, ' +
        '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}'; 
    const accountColKeysSettled = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${currency}, ${unit}, ${amount}, ' +
        '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}, ${settlementTime}, ${paymentRef}, ${paymentProvider}, ${floatAddTransactionId}, ${floatAllocTransactionId}';
    const floatColumnKeys = '${floatTransactionId}, ${clientId}, ${floatId}, ${transactionType}, ${currency}, ${unit}, ${amount}, ' + 
        '${allocatedToType}, ${allocatedToId}, ${transactionType}, ${accountTransactionId}';

    const createFloatQueryDef = (txIds) => {
        const expectedRowItem = {
            accountTransactionId: txIds[0],
            accountId: testAccountId,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            amount: testSaveAmount,
            floatId: testFloatId,
            clientId: testClientId
        };

        const expectedFloatAdditionRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedFloatAdditionRow.accountTransactionId = txIds[0];
        expectedFloatAdditionRow.floatTransactionId = txIds[1];
        expectedFloatAdditionRow.transactionType = 'USER_SAVING_EVENT';
        expectedFloatAdditionRow.allocatedToType = 'FLOAT_ITSELF';
        expectedFloatAdditionRow.allocatedToId = testFloatId;

        const expectedFloatAllocationRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedFloatAllocationRow.accountTransactionId = txIds[0];
        expectedFloatAllocationRow.floatTransactionId = txIds[2];
        expectedFloatAllocationRow.transactionType = 'ALLOCATION';
        expectedFloatAllocationRow.allocatedToType = 'END_USER_ACCOUNT';
        expectedFloatAllocationRow.allocatedToId = testAccountId;

        const floatRows = sinon.match([sinon.match(expectedFloatAdditionRow), sinon.match(expectedFloatAllocationRow)]);
        return { 
            query: insertFloatTxQuery,
            columnTemplate: floatColumnKeys,
            rows: floatRows
        };
    };

    it('Insert a pending state save, if status is initiated', async () => { 
        const testAcTxId = uuid();
        const testInitiationTime = moment().subtract(5, 'minutes');

        logger('Test TX ID for account: ', testAcTxId);
        uuidStub.onFirstCall().returns(testAcTxId);
        
        const expectedRowItem = {
            accountTransactionId: testAcTxId,
            accountId: testAccountId,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            amount: testSaveAmount,
            settlementStatus: 'INITIATED',
            initiationTime: testInitiationTime.format(),
            floatId: testFloatId,
            clientId: testClientId
        };
        
        const expectedAccountQueryDef = {
            query: insertAccNotSettledTxQuery,
            columnTemplate: accountColKeysNotSettled,
            rows: [expectedRowItem]
        };

        const expectedTxDetails = [{ 
            'accountTransactionId': testAcTxId,
            'creationTimeEpochMillis': sinon.match.number
        }];

        multiTableStub.withArgs(sinon.match([expectedAccountQueryDef])).resolves([[{ 'transaction_id': testAcTxId, 'creation_time': moment().format() }]]);

        const testNotSettledArgs = { 
            accountId: testAccountId,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            amount: testSaveAmount, 
            initiationTime: testInitiationTime,
            settlementStatus: 'INITIATED',
            floatId: testFloatId,
            clientId: testClientId
        };

        const resultOfInsertion = await rds.addSavingToTransactions(testNotSettledArgs);
        logger('args    :', multiTableStub.getCall(0).args[0][0]);
        logger('expected:', expectedAccountQueryDef);
        
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('transactionDetails');
        expect(resultOfInsertion.transactionDetails).to.be.an('array').that.has.length(1);
        expect(sinon.match(expectedTxDetails[0]).test(resultOfInsertion.transactionDetails[0])).to.be.true;

        // unsettled means no balance call
        expectNoCalls([queryStub, insertStub]);
    });

    it('Insert a settled save with float id, payment ref, etc., performing matching sides', async () => {
        const testAcTxId = sinon.match.string;
        const testFlTxAddId = sinon.match.string;
        const testFlTxAllocId = sinon.match.string;

        const testInitiationTime = moment().subtract(5, 'minutes');
        const testSettlementTime = moment();

        const expectedRowItem = {
            accountTransactionId: testAcTxId,
            accountId: testAccountId,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            amount: testSaveAmount,
            floatId: testFloatId,
            clientId: testClientId,
            settlementStatus: 'SETTLED',
            initiationTime: testInitiationTime.format(),
            settlementTime: testSettlementTime.format()
        };

        const expectedAccountRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedAccountRow.accountTransactionId = testAcTxId;
        expectedAccountRow.paymentRef = testPaymentRef;
        expectedAccountRow.paymentProvider = 'STRIPE';
        expectedAccountRow.floatAddTransactionId = testFlTxAddId;
        expectedAccountRow.floatAllocTransactionId = testFlTxAllocId;
        
        const expectedAccountQueryDef = { 
            query: insertAccSettledTxQuery,
            columnTemplate: accountColKeysSettled,
            rows: expectedAccountRow
        };

        const expectedFloatQueryDef = createFloatQueryDef([testAcTxId, testFlTxAddId, testFlTxAllocId]);
        
        const expectedArgs = sinon.match([expectedAccountQueryDef, expectedFloatQueryDef]);
        const txDetailsFromRds = [
            [{ 'transaction_id': uuid(), 'creation_time': moment().format() }],
            [{ 'transaction_id': uuid(), 'creation_time': moment().format()}, { 'transaction_id': uuid(), 'creation_time': moment().format() }]
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
        
        multiTableStub.resolves(txDetailsFromRds);

        // note: this is test elsewhere and is quite complex so no point repeating here
        queryStub.withArgs(sinon.match.any, [testAccountId, 'ZAR', sinon.match.any]).resolves([{ 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.withArgs(sinon.match.any, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.any]).resolves([{ 'sum': testSaveAmount, 'unit': 'HUNDREDTH_CENT' }]);
        
        const testSettledArgs = { 
            accountId: testAccountId,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            amount: testSaveAmount, 
            floatId: testFloatId,
            clientId: testClientId,
            initiationTime: testInitiationTime,
            settlementTime: testSettlementTime,
            paymentRef: testPaymentRef,
            paymentProvider: 'STRIPE',
            settlementStatus: 'SETTLED'
        };

        const resultOfSaveInsertion = await rds.addSavingToTransactions(testSettledArgs);
        logger('args    :', multiTableStub.getCall(0).args[0][0]);
        logger('expected:', expectedAccountQueryDef);

        expect(resultOfSaveInsertion).to.exist;
        expect(resultOfSaveInsertion).to.have.property('transactionDetails');
        expect(resultOfSaveInsertion.transactionDetails).to.be.an('array').that.has.length(3);
        expect(sinon.match(expectedTxDetails[0]).test(resultOfSaveInsertion.transactionDetails[0])).to.be.true;
        expect(sinon.match(expectedTxDetails[1]).test(resultOfSaveInsertion.transactionDetails[1])).to.be.true;
        expect(sinon.match(expectedTxDetails[2]).test(resultOfSaveInsertion.transactionDetails[2])).to.be.true;

        expect(resultOfSaveInsertion).to.have.property('newBalance');
        expect(resultOfSaveInsertion.newBalance).to.deep.equal({ amount: testSaveAmount, unit: 'HUNDREDTH_CENT' });

        expect(multiTableStub).to.have.been.calledOnce; // todo: add args
        expect(queryStub).to.have.been.calledThrice; // because also fetches timestamp
        expectNoCalls([insertStub]);
    });

    it('Updates a pending save to settled and ties up all parts of float, etc.', async () => {
        const testAcTxId = uuid();
        const testFlTxAddId = uuid();
        const testFlTxAllocId = uuid();

        const testPaymentDetails = { paymentProvider: 'STRIPE', paymentRef: testPaymentRef };
        const testSettlementTime = moment();

        const expectedTable = config.get('tables.accountTransactions');
        const expectedRetrieveTxQuery = `select * from ${expectedTable} where transaction_id = $1`;
        
        const expectedUpdateKey = { transactionId: testAcTxId };
        const expectedUpdateValue = {
            settlementStatus: 'SETTLED',
            settlementTime: testSettlementTime.format(),
            floatAdjustTxId: testFlTxAddId,
            floatAllocTxId: testFlTxAllocId,
            paymentReference: testPaymentRef,
            paymentProvider: 'STRIPE'
        };
        const expectedReturnClause = 'transaction_id, updated_time';
        const expectedUpdateDef = { table: expectedTable, key: expectedUpdateKey, value: expectedUpdateValue, returnClause: expectedReturnClause };
        
        const expectedFloatQueryDef = createFloatQueryDef([testAcTxId, testFlTxAddId, testFlTxAllocId]);
        
        const txDetailsFromRdsOnFetch = [{ 
            'transaction_id': testAcTxId, 'account_id': testAccountId, 'currency': 'ZAR', 'unit': 'HUNDREDTH_CENT', 'amount': 1050000,
            'float_id': testFloatId, 'client_id': testClientId
        }];
        const txDetailsFromRdsPostUpdate = [
            [{ 'transaction_id': testAcTxId, 'updated_time': moment().format() }],
            [{ 'transaction_id': testFlTxAddId, 'creation_time': moment().format()}, { 'transaction_id': testFlTxAllocId, 'creation_time': moment().format() }]
        ];

        // and, now, set up the stubs at last
        uuidStub.onFirstCall().returns(testFlTxAddId);
        uuidStub.onSecondCall().returns(testFlTxAllocId);

        queryStub.withArgs(expectedRetrieveTxQuery, [testAcTxId]).resolves(txDetailsFromRdsOnFetch);
        multiOpStub.withArgs([expectedUpdateDef], [expectedFloatQueryDef]).resolves(txDetailsFromRdsPostUpdate);

        // as above: this is tested elsewhere and is quite complex so no point repeating here
        queryStub.withArgs(sinon.match.any, [testAccountId, 'ZAR', sinon.match.any]).resolves([{ 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.withArgs(sinon.match.any, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.any]).resolves([{ 'sum': testSaveAmount, 'unit': 'HUNDREDTH_CENT' }]);        

        const expectedTxDetails = [{ 
            'accountTransactionId': testAcTxId,
            'updatedTimeEpochMillis': sinon.match.number
        }, { 
            'floatAdditionTransactionId': sinon.match.string,
            'creationTimeEpochMillis': sinon.match.number
        }, {
            'floatAllocationTransactionId': sinon.match.string,
            'creationTimeEpochMillis': sinon.match.number
        }];

        // logger('Expected float query def: ', expectedFloatQueryDef);

        const resultOfSaveUpdate = await rds.updateSaveTxToSettled(testAcTxId, testPaymentDetails, testSettlementTime);

        // testHelper.logNestedMatches(expectedUpdateDef, multiOpStub.getCall(0).args[0][0]);
        // testHelper.logNestedMatches(expectedFloatQueryDef, multiOpStub.getCall(0).args[1][0]);

        expect(resultOfSaveUpdate).to.exist;
        expect(resultOfSaveUpdate).to.have.property('transactionDetails');
        expect(resultOfSaveUpdate.transactionDetails).to.be.an('array').that.has.length(3);

        testHelper.logNestedMatches(expectedTxDetails[0], resultOfSaveUpdate.transactionDetails[0]);

        expect(sinon.match(expectedTxDetails[0]).test(resultOfSaveUpdate.transactionDetails[0])).to.be.true;
        expect(sinon.match(expectedTxDetails[1]).test(resultOfSaveUpdate.transactionDetails[1])).to.be.true;
        expect(sinon.match(expectedTxDetails[2]).test(resultOfSaveUpdate.transactionDetails[2])).to.be.true;

        expect(resultOfSaveUpdate).to.have.property('newBalance');
        expect(resultOfSaveUpdate.newBalance).to.deep.equal({ amount: testSaveAmount, unit: 'HUNDREDTH_CENT' });
    });

    // todo: restore
    // it('Throw an error if state is SETTLED but no float id', () => { });

    // it('Throws errors if missing necessary arguments (times, etc)', () => {    });

});

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Sums balances', () => {

    const testUserId1 = uuid();

    const testUserId2 = uuid();
    const testAccoundIdsMulti = [uuid(), uuid(), uuid()];

    const testBalance = Math.floor(100 * 100 * 100 * Math.random());
    const testBalanceCents = Math.round(testBalance);

    const txTable = config.get('tables.accountTransactions');
        const transTypes = `('USER_SAVING_EVENT','ACCRUAL','CAPITALIZATION','WITHDRAWAL')`;
        const unitQuery = `select distinct(unit) from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` + 
            `and creation_time < to_timestamp($3)`;
        const sumQuery = `select sum(amount), unit from ${txTable} where account_id = $1 and currency = $2 and unit = $3 and settlement_status = 'SETTLED' ` +
            `and creation_time < to_timestamp($4) and transaction_type in ${transTypes} group by unit`;
        const latestTxQuery = `select creation_time from ${txTable} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` +
            `and creation_time < to_timestamp($3) order by creation_time desc limit 1`;

    beforeEach(() => resetStubs());

    it('Obtain the balance of an account at a point in time correctly', async () => {
        const testTime = moment();
        const testLastTxTime = moment().subtract(5, 'hours');
        const unitQueryArgs = sinon.match([testAccountId, 'USD', testTime.unix()]);
        
        logger('Test time value of: ', testTime.valueOf());
        
        queryStub.withArgs(unitQuery, unitQueryArgs).resolves([{ 'unit': 'HUNDREDTH_CENT' }, { 'unit': 'WHOLE_CENT' }]);
        queryStub.withArgs(sumQuery, [testAccountId, 'USD', 'HUNDREDTH_CENT', testTime.unix()]).
            returns(Promise.resolve([{ 'sum': testBalance, 'unit': 'HUNDREDTH_CENT' }]));
        queryStub.withArgs(sumQuery, [testAccountId, 'USD', 'WHOLE_CENT', testTime.unix()]).
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

describe('*** UNIT TEST ADD TRANSACTION TO ACCOUNT ***', async () => {
    const testFlTxAdjustId = uuid();
    const testFlTxAllocId = uuid();
    const testAccountId = uuid();
    const testClientId = uuid();
    const testFloatId = uuid();
    const testTxId = uuid();

    const testCreationTime = moment().format();
    const testInitiationTime = moment();
    const testSettlementTime = moment(); 

    const testSaveAmount = 1050000;

    const expectedTxDetails = {
        accountId: testAccountId,
        currency: 'ZAR',
        unit: 'HUNDREDTH_CENT',
        amount: testSaveAmount, 
        floatId: testFloatId,
        clientId: testClientId,
        initiationTime: testInitiationTime,
        settlementTime: testSettlementTime,
        paymentRef: testPaymentRef,
        paymentProvider: 'STRIPE',
        settlementStatus: 'SETTLED'
    };

    beforeEach(() => {
       resetStubs();
    });

    it('Adds transaction to account', async () => {
        const findUnitsQuery = `select distinct(unit) from ${config.get('tables.accountTransactions')} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' and creation_time < to_timestamp($3)`;
        const sumQueryForUnit = `select sum(amount), unit from ${config.get('tables.accountTransactions')} where account_id = $1 and currency = $2 and unit = $3 and settlement_status = 'SETTLED' and ` + 
            `creation_time < to_timestamp($4) and transaction_type in ('USER_SAVING_EVENT','ACCRUAL','CAPITALIZATION','WITHDRAWAL') group by unit`;
        const findMomentOfLastSettlementQuery = `select creation_time from transaction_data.core_transaction_ledger where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' and creation_time < to_timestamp($3) order by creation_time desc limit 1`;
        uuidStub.onFirstCall().returns(testAccountId);
        uuidStub.onSecondCall().returns(testFlTxAdjustId);
        uuidStub.onThirdCall().returns(testFlTxAllocId);
        queryStub.withArgs(findUnitsQuery, [testAccountId, 'ZAR', sinon.match.number]).resolves([{ 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.withArgs(sumQueryForUnit, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.number]).resolves([{ 'unit': 'HUNDREDTH_CENT', 'sum': testSaveAmount }]);
        queryStub.withArgs(findMomentOfLastSettlementQuery, [testAccountId, 'ZAR', sinon.match.number]).resolves([{ 'creation_time': testCreationTime }]);
        multiTableStub.resolves([
            [{ 'transaction_id': testTxId, 'creation_time': testCreationTime }],
            [{ 'transaction_id': testTxId, 'creation_time': testCreationTime }]
        ]);

        const resultOfInsertion = await rds.addTransactionToAccount(expectedTxDetails);
        logger('Result of transaction insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('transactionDetails');
        expect(resultOfInsertion.transactionDetails[0]).to.have.keys(['accountTransactionId', 'creationTimeEpochMillis']);
        expect(resultOfInsertion.transactionDetails[1]).to.have.keys(['floatAdditionTransactionId', 'creationTimeEpochMillis']);
        expect(resultOfInsertion.transactionDetails[2]).to.have.keys(['floatAllocationTransactionId', 'creationTimeEpochMillis']);
        expect(resultOfInsertion).to.have.property('newBalance');
        expect(resultOfInsertion.newBalance).to.deep.equal({ amount: testSaveAmount, unit: 'HUNDREDTH_CENT' });
        expect(uuidStub).to.have.been.calledThrice;
        expect(queryStub).to.have.been.calledWith(findUnitsQuery, [testAccountId, 'ZAR', sinon.match.number]);
        expect(queryStub).to.have.been.calledWith(sumQueryForUnit, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.number]);
        expect(queryStub).to.have.been.calledWith(findMomentOfLastSettlementQuery, [testAccountId, 'ZAR', sinon.match.number]);
        expect(multiTableStub).to.have.been.calledOnce;
    });
});

describe('*** UNIT TEST SETTLED TRANSACTION UPDATES ***', async () => {
    const testSettlementTime = moment();
    const testUpdatedTime = moment().format();
    const testCreationTime = moment().format();

    const testTxId = uuid();
    const testAccountId = uuid();
    const testSaveAmount = 1000;
    const testFloatId = uuid();
    const testClientId = uuid();
    const testFlTxAdjustId = uuid();
    const testFlTxAllocId = uuid();

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

    beforeEach(() => {
        resetStubs();
     }); 

    it('Updates transaction to settled', async () => {
        const pendingTxQuery = `select * from ${config.get('tables.accountTransactions')} where transaction_id = $1`;
        const findUnitsQuery = `select distinct(unit) from ${config.get('tables.accountTransactions')} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' and creation_time < to_timestamp($3)`;
        const sumQueryForUnit = `select sum(amount), unit from ${config.get('tables.accountTransactions')} where account_id = $1 and currency = $2 and unit = $3 and settlement_status = 'SETTLED' and ` + 
            `creation_time < to_timestamp($4) and transaction_type in ('USER_SAVING_EVENT','ACCRUAL','CAPITALIZATION','WITHDRAWAL') group by unit`;
        const findMomentOfLastSettlementQuery = `select creation_time from transaction_data.core_transaction_ledger where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' and creation_time < to_timestamp($3) order by creation_time desc limit 1`;
        uuidStub.onFirstCall().returns(testFlTxAdjustId);
        uuidStub.onSecondCall().returns(testFlTxAllocId);
        queryStub.withArgs(pendingTxQuery, [testTxId]).resolves([expectedRowItem]);
        queryStub.withArgs(findUnitsQuery, [testAccountId, 'ZAR', sinon.match.number]).resolves([{ 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.withArgs(sumQueryForUnit, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.number]).resolves([{ 'unit': 'HUNDREDTH_CENT', 'sum': 1000 }]);
        queryStub.withArgs(findMomentOfLastSettlementQuery, [testAccountId, 'ZAR', sinon.match.number]).resolves([{ 'creation_time': testCreationTime }]);
        multiOpStub.resolves([
            [{ 'transaction_id': testTxId, 'account_id': testAccountId, 'updated_time': testUpdatedTime }],
            [{ 'transaction_id': testTxId, 'creation_time': testCreationTime }]
        ]);

        const expectedEvent = {
            transactionId: testTxId,
            paymentDetails: { paymentProvider: 'STRIPE', paymentRef: testPaymentRef },
            settlementTime: testSettlementTime
        };

        const resultOfUpdate = await rds.updateTxToSettled(expectedEvent);
        logger('Result of update:', resultOfUpdate);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('transactionDetails');
        expect(resultOfUpdate.transactionDetails[0]).to.have.keys(['accountTransactionId', 'updatedTimeEpochMillis']);
        expect(resultOfUpdate.transactionDetails[1]).to.have.keys(['floatAdditionTransactionId', 'creationTimeEpochMillis']);
        expect(resultOfUpdate.transactionDetails[2]).to.have.keys(['floatAllocationTransactionId', 'creationTimeEpochMillis']);
        expect(resultOfUpdate).to.have.property('newBalance');
        expect(resultOfUpdate.newBalance).to.deep.equal({ amount: 1000, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });
        expect(uuidStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWith(pendingTxQuery, [testTxId]);
        expect(queryStub).to.have.been.calledWith(findUnitsQuery, [testAccountId, 'ZAR', sinon.match.number]);
        expect(queryStub).to.have.been.calledWith(sumQueryForUnit, [testAccountId, 'ZAR', 'HUNDREDTH_CENT', sinon.match.number]);
        expect(queryStub).to.have.been.calledWith(findMomentOfLastSettlementQuery, [testAccountId, 'ZAR', sinon.match.number]);
        expect(multiOpStub).to.have.been.calledOnce;
    });
});

describe('*** UNIT TEST UTILITY FUNCTIONS ***', async () => {

    const testTxId = uuid();
    const testAccountId = uuid();
    const testSaveAmount = 1000;
    const testFloatId = uuid();
    const testClientId = uuid();

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
        const currencyQuery = `select currency, count(currency) as currency_count from ${config.get('tables.accountTransactions')} where account_id = $1 group by currency order by currency_count desc limit 1`
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
