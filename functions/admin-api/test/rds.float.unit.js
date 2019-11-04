'use strict';

const logger = require('debug')('jupiter:admin:rds-float-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

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

const persistence = proxyquire('../persistence/rds.float', {
    'rds-common': MockRdsConnection
});

describe('*** UNIT TEST RDS FLOAT FUNCTIONS ***', () => {
    const testUserId = uuid();
    const testFloatId = uuid();
    const testClientId = uuid();

    const testReferenceTime = moment().format();
    const testCreationTime = moment().format();
    const testStartTime = moment();
    const testEndTime = moment();

    beforeEach(() => {
        helper.resetStubs(queryStub, updateRecordStub, insertRecordsStub);
    })

    it('Gets float balance', async () => {        

        queryStub.resolves([{ 'float_id': testFloatId, 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 100 }]);

        const result = await persistence.getFloatBalanceAndFlows([testFloatId], testStartTime, testEndTime);
        logger('Result of float and balance and flows extraction:', result);


    });

    it('Gets float allocated total', async () => {

        queryStub.resolves([{ 'float_id': testFloatId, 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 100 }]);

        const result = await persistence.getFloatAllocatedTotal(testClientId, testFloatId, testStartTime, testEndTime);
        logger('Result of float allocated total extraction:', result);
    });

    it('Gets user allocation and accounts transactions', async () => {

        queryStub.resolves([{ 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 100 }]);

        const result = await persistence.getUserAllocationsAndAccountTxs(testClientId, testFloatId, testStartTime, testEndTime);
        logger('Result of float and balance and flows extraction:', result);
    });

    it('Gets float bonus balance', async () => {

        queryStub.resolves([{ 'float_id': testFloatId, 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'allocated_to_id': testUserId, 'sum': 100 }]);

        const result = await persistence.getFloatBonusBalanceAndFlows([testFloatId], testStartTime, testEndTime, 1);
        logger('Result of float bonus balance and flows extraction:', result);
    });

    it('Gets last float accrual time', async () => {
       

        queryStub.resolves([{ 'reference_time': testReferenceTime, 'creation_time': testCreationTime }]);

        const result = await persistence.getLastFloatAccrualTime(testClientId, testFloatId);
        logger('Result of last float accrual time extraction:', result);
    });

    it('Returns creation time where no float accrual has occured', async () => {

        queryStub.onCall(0).resolves([]);
        queryStub.resolves([{ 'creation_time': testCreationTime }]);

        const result = await persistence.getLastFloatAccrualTime(testClientId, testFloatId);
        logger('Result of last float accrual time extraction:', result);
    });

    it('Gets float alerts', async () => {

        const expectedResult = {
            'log_id': uuid(),
            'client_id': testClientId,
            'float_id': testFloatId,
            'creation_time': testCreationTime,
            'updated_time': moment().format(),
            'reference_time': moment().format(),
            'log_type': 'BALANCE_UNOBTAINABLE',
            'log_context': { resolved: false },
        };

        queryStub.resolves([expectedResult, expectedResult, expectedResult]);

        const result = await persistence.getFloatAlerts(testClientId, testFloatId);
        logger('Got alerts:', result);
    });

    it('Inserts float log', async () => {
        const testLogObject = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: '',
            logContext: { }
        };

        insertRecordsStub.resolves({ 'command': 'INSERT', rows: [{ 'log_id': uuid() }]})

        const insertionResult = await persistence.insertFloatLog(testLogObject);
        logger('Result of log log insertion:', insertionResult);
        
    });

    it('Updates float log', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'It is done.';

        const testLogContext = {
            resolved: true,
            resolvedByUserId: testUserId,
            resolutionNote: testResolutionNote
        };

        updateRecordStub.resolves({ 'command': 'UPDATE', 'rows': [{ 'updated_time': moment().format() }]})

        const updateResult = await persistence.updateFloatLog({ logId: testLogId, contextToUpdate: testLogContext});
        logger('Result of log update:', updateResult);
    });
});