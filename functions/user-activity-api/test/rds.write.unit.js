'use strict';

// const logger = require('debug')('jupiter:activity-rds:test');

const config = require('config');
const moment = require('moment-timezone');
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
const multiOpStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.updateRecord = updateRecordStub;
        this.updateRecordObject = updateRecordsStub;
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
    testHelper.resetStubs(queryStub, insertStub, multiTableStub, multiOpStub, uuidStub, updateRecordStub, updateRecordsStub);
    uuidStub.callsFake(uuid); // not actually a fake but call through is tricky, so this is simpler
};

const expectNoCalls = (stubList) => stubList.forEach((stub) => expect(stub).to.not.have.been.called);

const testFloatId = 'zar_cash_float';
const testClientId = 'pluto_savings_za';
const testAccountId = uuid();
const testPaymentRef = uuid();
const testUserId = uuid();

describe('*** USER ACTIVITY *** UNIT TEST RDS *** Insert transaction alone and with float', () => {

    beforeEach(() => resetStubs());

    const testSaveAmount = 1050000;

    const insertAccNotSettledTxQuery = `insert into ${config.get('tables.accountTransactions')} (transaction_id, transaction_type, account_id, currency, unit, ` +
        `amount, float_id, client_id, settlement_status, initiation_time, human_reference, tags) values %L returning transaction_id, creation_time`;
    const insertFloatTxQuery = `insert into ${config.get('tables.floatTransactions')} (transaction_id, client_id, float_id, t_type, ` +
        `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;
    
    const accountColKeysNotSettled = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${currency}, ${unit}, ${amount}, ' +
        '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}, ${humanRef}, ${tags}'; 
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
        expectedFloatAllocationRow.transactionType = 'USER_SAVING_EVENT';
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
            clientId: testClientId,
            humanRef: '',
            tags: []
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

        multiTableStub.resolves([[{ 'transaction_id': testAcTxId, 'creation_time': moment().format() }]]);

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

        const resultOfInsertion = await rds.addTransactionToAccount(testNotSettledArgs);
        // logger('args    :', multiTableStub.getCall(0).args[0][0]);
        // logger('expected:', expectedAccountQueryDef);
        
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('transactionDetails');
        expect(resultOfInsertion.transactionDetails).to.be.an('array').that.has.length(1);
        expect(sinon.match(expectedTxDetails[0]).test(resultOfInsertion.transactionDetails[0])).to.be.true;

        expect(multiTableStub).to.have.been.calledOnceWithExactly([expectedAccountQueryDef]);

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
            settlementTime: testSettlementTime.format(),
            tags: []
        };

        const expectedAccountRow = JSON.parse(JSON.stringify(expectedRowItem));
        expectedAccountRow.accountTransactionId = testAcTxId;
        expectedAccountRow.paymentRef = testPaymentRef;
        expectedAccountRow.paymentProvider = 'STRIPE';
        expectedAccountRow.floatAddTransactionId = testFlTxAddId;
        expectedAccountRow.floatAllocTransactionId = testFlTxAllocId;
                
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
        queryStub.onFirstCall().resolves([{ 'sum': testSaveAmount, 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.onSecondCall().resolves([]);
        
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

        const resultOfSaveInsertion = await rds.addTransactionToAccount(testSettledArgs);
        // logger('args    :', multiTableStub.getCall(0).args[0][0]);
        // logger('expected:', expectedAccountQueryDef);

        expect(resultOfSaveInsertion).to.exist;
        expect(resultOfSaveInsertion).to.have.property('transactionDetails');
        expect(resultOfSaveInsertion.transactionDetails).to.be.an('array').that.has.length(3);
        expect(sinon.match(expectedTxDetails[0]).test(resultOfSaveInsertion.transactionDetails[0])).to.be.true;
        expect(sinon.match(expectedTxDetails[1]).test(resultOfSaveInsertion.transactionDetails[1])).to.be.true;
        expect(sinon.match(expectedTxDetails[2]).test(resultOfSaveInsertion.transactionDetails[2])).to.be.true;

        expect(resultOfSaveInsertion).to.have.property('newBalance');
        expect(resultOfSaveInsertion.newBalance).to.deep.equal({ amount: testSaveAmount, unit: 'HUNDREDTH_CENT' });

        expect(multiTableStub).to.have.been.calledOnce; // todo: add args
        // const insertAccSettledTxQuery = `insert into ${config.get('tables.accountTransactions')} (transaction_id, transaction_type, account_id, currency, unit, ` +
        //     `amount, float_id, client_id, human_reference, tags, settlement_status, initiation_time, settlement_time, payment_reference, payment_provider, float_adjust_tx_id, float_alloc_tx_id) values %L returning transaction_id, creation_time`;

        // const accountColKeysSettled = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${currency}, ${unit}, ${amount}, ' +
        //     '${floatId}, ${clientId}, ${humanRef}, ${settlementStatus}, ${initiationTime}, ${settlementTime}, ${paymentRef}, ${paymentProvider}, ${floatAddTransactionId}, ${floatAllocTransactionId}';

        // const expectedAccountQueryDef = { 
        //     query: insertAccSettledTxQuery,
        //     columnTemplate: accountColKeysSettled,
        //     rows: expectedAccountRow
        // };

        expect(queryStub).to.have.been.calledTwice; // because also fetches timestamp
        expectNoCalls([insertStub]);
    });

    it('Fail on invalid transaction details', async () => {
        const testInitiationTime = moment().subtract(5, 'minutes');
        const testSettlementTime = moment();

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

        Reflect.deleteProperty(testNotSettledArgs, 'accountId');
        await expect(rds.addTransactionToAccount(testNotSettledArgs)).to.be.rejectedWith('Missing required property: accountId');
        testNotSettledArgs.accountId = testAccountId;

        testNotSettledArgs.settlementStatus = 'INVALID_SETTLEMENT_STATUS';
        await expect(rds.addTransactionToAccount(testNotSettledArgs)).to.be.rejectedWith('Invalid settlement status: INVALID_SETTLEMENT_STATUS');
        testNotSettledArgs.settlementStatus = 'INITIATED';

        testNotSettledArgs.initiationTime = '2027-10-28T15:45:45+02:00'; // must be a moment instance
        await expect(rds.addTransactionToAccount(testNotSettledArgs)).to.be.rejectedWith('Unexpected initiation time format');
        testNotSettledArgs.initiationTime = testInitiationTime;

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

        Reflect.deleteProperty(testSettledArgs, 'paymentRef');
        await expect(rds.addTransactionToAccount(testSettledArgs)).to.be.rejectedWith('Missing required property: paymentRef');
        testSettledArgs.paymentRef = testPaymentRef;

        testSettledArgs.settlementTime = '2027-10-28T15:45:45+02:00'; // must be a moment instance
        await expect(rds.addTransactionToAccount(testSettledArgs)).to.be.rejectedWith('Unexpected settlement time format');
        testSettledArgs.settlementTime = testSettlementTime;

        testSettledArgs.settlementTime = moment().subtract(6, 'minutes');
        await expect(rds.addTransactionToAccount(testSettledArgs)).to.be.rejectedWith('Settlement cannot occur before initiation');

        expectNoCalls([queryStub, insertStub, multiTableStub]);
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
        const expectedReturnClause = 'transaction_id, account_id, updated_time';
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

        const testLogId = uuid();
        const expectedLogQueryDef = { 
            query: 'insert into account_data.account_log (log_id, account_id, transaction_id, reference_time, creating_user_id, log_type, log_context) values %L',
            columnTemplate: '${logId}, ${accountId}, ${transactionId}, ${referenceTime}, ${settlingUserId}, *{TRANSACTION_SETTLED}, ${logContext}',
            rows: [{
                logId: testLogId,
                accountId: testAccountId,
                transactionId: testAcTxId,
                referenceTime: testSettlementTime.format(),
                settlingUserId: testUserId,
                logContext: testPaymentDetails
            }]
        };

        // and, now, set up the stubs at last
        uuidStub.onFirstCall().returns(testFlTxAddId);
        uuidStub.onSecondCall().returns(testFlTxAllocId);
        uuidStub.onThirdCall().returns(testLogId);

        queryStub.withArgs(expectedRetrieveTxQuery, [testAcTxId]).resolves(txDetailsFromRdsOnFetch);
        multiOpStub.resolves(txDetailsFromRdsPostUpdate);

        // note: this is test elsewhere and is quite complex so no point repeating here
        queryStub.onSecondCall().resolves([{ 'sum': testSaveAmount, 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.onThirdCall().resolves([]);

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

        const testEvent = { transactionId: testAcTxId, paymentDetails: testPaymentDetails, settlementTime: testSettlementTime, settlingUserId: testUserId };
        const resultOfSaveUpdate = await rds.updateTxToSettled(testEvent);

        expect(resultOfSaveUpdate).to.exist;
        expect(resultOfSaveUpdate).to.have.property('transactionDetails');
        expect(resultOfSaveUpdate.transactionDetails).to.be.an('array').that.has.length(3);

        testHelper.logNestedMatches(expectedTxDetails[0], resultOfSaveUpdate.transactionDetails[0]);

        expect(sinon.match(expectedTxDetails[0]).test(resultOfSaveUpdate.transactionDetails[0])).to.be.true;
        expect(sinon.match(expectedTxDetails[1]).test(resultOfSaveUpdate.transactionDetails[1])).to.be.true;
        expect(sinon.match(expectedTxDetails[2]).test(resultOfSaveUpdate.transactionDetails[2])).to.be.true;

        expect(resultOfSaveUpdate).to.have.property('newBalance');
        expect(resultOfSaveUpdate.newBalance).to.deep.equal({ amount: testSaveAmount, currency: 'ZAR', unit: 'HUNDREDTH_CENT' });

        expect(multiOpStub).to.have.been.calledOnceWithExactly([expectedUpdateDef], [expectedFloatQueryDef, expectedLogQueryDef]);
    });

    it('If a transaction is already settled, skip update step', async () => {
        const testAdjustTxId = uuid();
        const testAllocTxId = uuid();
        const transactionId = uuid();
        const paymentDetails = { paymentProvider: 'STRIPE', paymentRef: testPaymentRef };
        const settlementTime = moment();

        const expectedTable = config.get('tables.accountTransactions');
        const expectedRetrieveTxQuery = `select * from ${expectedTable} where transaction_id = $1`;

        const txDetailsFromRdsOnFetch = [{ 
            'transaction_id': transactionId, 'account_id': testAccountId, 'currency': 'ZAR', 'unit': 'HUNDREDTH_CENT', 'amount': 1050000,
            'float_adjust_tx_id': testAdjustTxId, 'float_alloc_tx_id': testAllocTxId, 'settlement_status': 'SETTLED'
        }];

        queryStub.withArgs(expectedRetrieveTxQuery, [transactionId]).resolves(txDetailsFromRdsOnFetch);

        // note: this is test elsewhere and is quite complex so no point repeating here
        queryStub.onSecondCall().resolves([{ 'sum': testSaveAmount, 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.onThirdCall().resolves([]);
                        
        const resultOfUpdate = await rds.updateTxToSettled({ transactionId, paymentDetails, settlementTime });
        expect(resultOfUpdate).to.exist;
        // todo: add expectations   
    });

    // it('Throws errors if missing necessary arguments (times, etc)', () => {    });

});

describe('*** UNIT TEST SETTLED TRANSACTION UPDATES ***', async () => {
    const testSettlementTime = moment();
    const testUpdatedTime = moment().format();
    const testCreationTime = moment().format();

    const testTxId = uuid();
    const testSaveAmount = 1000;
    const testFlTxAdjustId = uuid();
    const testFlTxAllocId = uuid();

    const expectedRowItem = {
        'account_transaction_id': testTxId,
        'account_id': testAccountId,
        'transaction_type': 'USER_SAVING_EVENT',
        'currency': 'ZAR',
        'unit': 'HUNDREDTH_CENT',
        'amount': testSaveAmount,
        'float_id': testFloatId,
        'client_id': testClientId,
        'settlement_status': 'PENDING',
        'initiation_time': moment().subtract(5, 'minutes').format(),
        'settlement_time': moment().format()
    };

    beforeEach(() => {
        resetStubs();
     }); 

    it('Updates transaction to settled', async () => {
        const pendingTxQuery = `select * from ${config.get('tables.accountTransactions')} where transaction_id = $1`;
        
        uuidStub.onFirstCall().returns(testFlTxAdjustId);
        uuidStub.onSecondCall().returns(testFlTxAllocId);
        
        queryStub.withArgs(pendingTxQuery, [testTxId]).resolves([expectedRowItem]);
        
        // note: this is test elsewhere and is quite complex so no point repeating here
        queryStub.onSecondCall().resolves([{ 'sum': testSaveAmount, 'unit': 'HUNDREDTH_CENT' }]);
        queryStub.onThirdCall().resolves([{ 'creation_time': testCreationTime }]);
        
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
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('transactionDetails');
        
        expect(resultOfUpdate.transactionDetails[0]).to.have.keys(['accountTransactionId', 'accountTransactionType', 'updatedTimeEpochMillis']);
        expect(resultOfUpdate.transactionDetails[1]).to.have.keys(['floatAdditionTransactionId', 'creationTimeEpochMillis']);
        expect(resultOfUpdate.transactionDetails[2]).to.have.keys(['floatAllocationTransactionId', 'creationTimeEpochMillis']);
        
        expect(resultOfUpdate).to.have.property('newBalance');
        expect(resultOfUpdate.newBalance).to.deep.equal({ amount: 1000, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });
        
        // arguments on stub are checked above (this test is slightly duplicative)
        expect(uuidStub).to.have.been.calledThrice;
        expect(queryStub).to.have.been.calledWith(pendingTxQuery, [testTxId]);
        expect(multiOpStub).to.have.been.calledOnce;
    });

    it('Updates transaction with payment info, if all given', async () => {
        const updateTime = moment();
        
        const expectedQuery = `update transaction_data.core_transaction_ledger set payment_provider = $1, ` +
        `payment_reference = $2, human_reference = $3, tags = array_append(tags, $4) where transaction_id = $5 returning updated_time`;
        const expectedValues = ['PROVIDER', 'test-reference', 'JUPSAVER31-0001', `PAYMENT_URL::https://someurl`, testTxId];

        updateRecordStub.resolves({ 'rows': [{ 'updated_time': updateTime.format() }] });

        const passedParams = { transactionId: testTxId, paymentUrl: 'https://someurl', paymentProvider: 'PROVIDER', paymentRef: 'test-reference', bankRef: 'JUPSAVER31-0001' };
        
        const resultOfUpdate = await rds.addPaymentInfoToTx(passedParams);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('updatedTime');
        expect(resultOfUpdate.updatedTime).to.deep.equal(moment(updateTime.format()));
        
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    // e.g., in switching from manual to instant and back, do not overwrite
    it('Updates transaction with payment info, but does not overwrite blank fields', async () => {
        const updateTime = moment();
        
        const expectedQuery = `update transaction_data.core_transaction_ledger set payment_provider = $1, ` +
            `human_reference = $2 where transaction_id = $3 returning updated_time`;
        const expectedValues = ['MANUAL_EFT', 'JUPSAVER31-0001', testTxId];

        updateRecordStub.resolves({ 'rows': [{ 'updated_time': updateTime.format() }] });

        const passedParams = { transactionId: testTxId, paymentProvider: 'MANUAL_EFT', bankRef: 'JUPSAVER31-0001' };
        
        const resultOfUpdate = await rds.addPaymentInfoToTx(passedParams);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('updatedTime');
        expect(resultOfUpdate.updatedTime).to.deep.equal(moment(updateTime.format()));
        
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Updates transaction tags', async () => {
        const updateTime = moment();
        const testTag = 'FINWORKS_RECORDED';
        
        const accountTxTable = config.get('tables.accountTransactions');
        const updateQuery = `update ${accountTxTable} set tags = array_append(tags, $1) where transaction_id = $2 returning updated_time`;

        updateRecordStub.withArgs(updateQuery, [testTag, testTxId]).resolves({ rows: [{ 'updated_time': updateTime.format() }] });

        const updateResult = await rds.updateTxTags(testTxId, testTag);

        expect(updateResult).to.exist;
        expect(updateResult).to.have.property('updatedTime');
        expect(updateResult.updatedTime).to.deep.equal(moment(updateTime.format()));
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(updateQuery, [testTag, testTxId]);
    });

    it('Updates transaction tags', async () => {
        const updateTime = moment();
        const testTag = 'FINWORKS::POL1';
        
        const userAccountTable = config.get('tables.accountLedger');
        const updateTagQuery = `update ${userAccountTable} set tags = array_append(tags, $1) where owner_user_id = $2 returning updated_time`;

        updateRecordStub.resolves({ rows: [{ 'updated_time': updateTime.format() }] });

        const updateResult = await rds.updateAccountTags(testUserId, testTag);

        expect(updateResult).to.exist;
        expect(updateResult).to.have.property('updatedTime');
        expect(updateResult.updatedTime).to.deep.equal(moment(updateTime.format()));
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(updateTagQuery, [testTag, testUserId]);
    });

    it('Updates transaction settlement status', async () => {
        const testTransactionId = uuid();
        const testSettlementStatus = 'PENDING';

        updateRecordsStub.resolves([{ 'updated_time': testUpdatedTime }]);

        const expectedArgs = {
            key: { transactionId: testTransactionId},
            value: { settlementStatus: testSettlementStatus },
            table: config.get('tables.accountTransactions'),
            returnClause: 'updated_time'
        };

        const params = {
            transactionId: testTransactionId,
            settlementStatus: testSettlementStatus
        };

        const updateResult = await rds.updateTxSettlementStatus(params);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(moment(testUpdatedTime));
        expect(updateRecordsStub).to.have.been.calledOnceWithExactly(expectedArgs);
    });

    it('Update settlement status including log context', async () => {
        const testLogId = uuid();

        const testReferenceTime = moment();

        const passedLogObject = {
            accountId: 'some-person-account',
            referenceTime: testReferenceTime,
            systemWideUserId: testUserId,
            logContext: { oldStatus: 'PENDING', newStatus: 'CANCELLED' }
        };

        const expectedLogObject = {
            logId: testLogId,
            transactionId: testTxId,
            accountId: 'some-person-account',
            logType: 'UPDATED_TX_STATUS', 
            creatingUserId: testUserId,
            referenceTime: testReferenceTime.format(),
            logContext: passedLogObject.logContext
        };

        const expectedInsert = {
            query: `insert into account_data.account_log (log_id, account_id, transaction_id, reference_time, creating_user_id, log_type, log_context) values %L`,
            columnTemplate: '${logId}, ${accountId}, ${transactionId}, ${referenceTime}, ${creatingUserId}, ${logType}, ${logContext}',
            rows: [expectedLogObject]
        };
    
        const params = {
            transactionId: testTxId,
            settlementStatus: 'CANCELLED',
            logToInsert: passedLogObject
        };

        // tested above, so no need to duplicate checks
        uuidStub.returns(testLogId);
        updateRecordsStub.resolves([{ 'updated_time': testUpdatedTime }]);

        const updateResult = await rds.updateTxSettlementStatus(params);
        expect(updateResult).to.exist;

        expect(updateRecordsStub).to.have.been.calledOnce; // as above
        // const insertArgs = insertStub.getCall(0).args;
        // expect(insertArgs[0]).to.equal(expectedInsert.query);
        // expect(insertArgs[1]).to.equal(expectedInsert.columnTemplate);
        // expect(insertArgs[2]).to.deep.equal(expectedInsert.rows);
        expect(insertStub).to.have.been.calledOnceWithExactly(expectedInsert.query, expectedInsert.columnTemplate, expectedInsert.rows);
    });

    it('Transaction settlment status update fails on invalid parameters', async () => {
        const testTransactionId = uuid();
        const testSettlementStatus = 'SETTLED';

        const params = {
            transactionId: testTransactionId,
            settlementStatus: testSettlementStatus
        };

        await expect(rds.updateTxSettlementStatus(params)).to.eventually.be.rejectedWith('Use settle TX for this operation');
        Reflect.deleteProperty(params, 'settlementStatus');
        await expect(rds.updateTxSettlementStatus(params)).to.eventually.be.rejectedWith('Must supply settlement status');
        expect(updateRecordsStub).to.have.not.been.called;
    });

    it('Updates settlement status to LOCKED, sets lock expiry and bonus amount tag', async () => {
        const testTransactionId = uuid();
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
