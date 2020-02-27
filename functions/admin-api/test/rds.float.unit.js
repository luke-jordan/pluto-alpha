'use strict';

const logger = require('debug')('jupiter:admin:rds-float-test');
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

    const floatTxTable = config.get('tables.floatTxTable');
    const floatLogTable = config.get('tables.floatLogTable');
    const accountTxTable = config.get('tables.transactionTable');

    beforeEach(() => {
        helper.resetStubs(queryStub, updateRecordStub, insertRecordsStub);
    });

    it('Gets float balance', async () => {
        const expectedQuery = `select float_id, currency, unit, sum(amount) from ${floatTxTable} where ` + 
           `allocated_to_type = $1 and t_state = $2 and creation_time between $3 and $4 and float_id in ($5) group by float_id, currency, unit`;
        const expectedValues = [
            'FLOAT_ITSELF',
            'SETTLED',
            testStartTime.format(),
            testEndTime.format(),
            testFloatId
        ];

        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'float_id': testFloatId, 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 100 }]);

        const expectedResult = new Map([[testFloatId, { 'USD': { amount: 100, unit: 'HUNDREDTH_CENT' }}]]);

        const result = await persistence.getFloatBalanceAndFlows([testFloatId], testStartTime, testEndTime);
        logger('Result of float and balance and flows extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Gets float allocated total', async () => {
        const expectedQuery = `select float_id, currency, unit, sum(amount) from ${floatTxTable} ` + 
            `where allocated_to_type != $1 and t_state = $2 and creation_time between $3 and $4 and client_id = $5 and float_id = $6 ` + 
            `group by float_id, currency, unit`;
        const expectedValues = ['FLOAT_ITSELF', 'SETTLED', testStartTime.format(), testEndTime.format(), testClientId, testFloatId];

        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'float_id': testFloatId, 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 100 }]);

        const expectedResult = { USD: { amount: 100, unit: 'HUNDREDTH_CENT' } };

        const result = await persistence.getFloatAllocatedTotal(testClientId, testFloatId, testStartTime, testEndTime);
        logger('Result of float allocated total extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Gets user allocation and accounts transactions', async () => {
        const expectedQuery = `select currency, unit, sum(amount) from ${floatTxTable} where ` + 
            `allocated_to_type = $1 and t_state = $2 and creation_time between $3 and $4 and client_id = $5 and float_id = $6 group by currency, unit`;
        const expectedValues = ['END_USER_ACCOUNT', 'SETTLED', testStartTime.format(), testEndTime.format(), testClientId, testFloatId];

        const expectedSettlementQuery = `select currency, unit, sum(amount) from ${accountTxTable} where ` +
            `settlement_status = $1 and settlement_time between $2 and $3 and client_id = $4 and float_id = $5 ` +
            `group by currency, unit`;
        const expectedSettlementValues = ['SETTLED', testStartTime.format(), testEndTime.format(), testClientId, testFloatId];

        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 100 }]);
        queryStub.withArgs(expectedSettlementQuery, expectedSettlementValues).resolves([
            {'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'sum': 200 }
        ]);

        const expectedResult = {
            floatAccountTotal: { USD: { amount: 100, unit: 'HUNDREDTH_CENT' } },
            accountTxTotal: { USD: { amount: 200, unit: 'HUNDREDTH_CENT' } }
        };

        const result = await persistence.getUserAllocationsAndAccountTxs(testClientId, testFloatId, testStartTime, testEndTime);
        logger('Result of float and balance and flows extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledWith(expectedQuery, expectedValues);
        expect(queryStub).to.have.been.calledWith(expectedSettlementQuery, expectedSettlementValues);
    });

    it('Gets float bonus balance', async () => {
        const expectedQuery = `select float_id, currency, unit, allocated_to_id, sum(amount) from ` + 
            `${floatTxTable} where allocated_to_type = $1 and t_state = $2 and creation_time between $3 ` + 
            `and $4 and amount > 0 and float_id in ($5) group by float_id, currency, unit, allocated_to_id`;
        const expectedValues = ['BONUS_POOL', 'SETTLED', testStartTime.format(), testEndTime.format(), testFloatId];

        queryStub.resolves([{ 'float_id': testFloatId, 'currency': 'USD', 'unit': 'HUNDREDTH_CENT', 'allocated_to_id': testUserId, 'sum': 100 }]);

        const expectedResult = new Map([[testFloatId, { [testUserId]: { USD: { amount: 100, unit: 'HUNDREDTH_CENT' }}}]]);

        const result = await persistence.getFloatBonusBalanceAndFlows([testFloatId], testStartTime, testEndTime, 1);
        logger('Result of float bonus balance and flows extraction:', result);
        logger('Expected:', expectedResult);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Gets last float accrual time', async () => {
        const expectedQuery = `select reference_time from float_data.float_log where float_id = $1 and ` + 
            `client_id = $2 and log_type = $3 order by creation_time desc limit 1`;
        const expectedValues = [testFloatId, testClientId, 'WHOLE_FLOAT_ACCRUAL'];

        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'reference_time': testReferenceTime, 'creation_time': testCreationTime }]);

        const result = await persistence.getLastFloatAccrualTime(testFloatId, testClientId);
        logger('Result of last float accrual time extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(moment(testReferenceTime));
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Returns creation time where no float accrual has occured', async () => {
        const expectedQuery = `select creation_time from ${floatTxTable} where float_id = $1 and client_id = $2 and allocated_to_type = $3 ` +
            `order by creation_time asc limit 1`;
        const expectedValues = [testFloatId, testClientId, 'FLOAT_ITSELF'];

        queryStub.onFirstCall().resolves([]);
        queryStub.withArgs(expectedQuery, expectedValues).resolves([{ 'creation_time': testCreationTime }]);

        const result = await persistence.getLastFloatAccrualTime(testFloatId, testClientId);
        logger('Result of last float accrual time extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(moment(testCreationTime));
        expect(queryStub).to.have.been.calledWith(expectedQuery, expectedValues);
    });

    it('Gets float alerts', async () => {
        const logTypes = config.get('defaults.floatAlerts.logTypes');
        const expectedQuery = `select * from ${floatLogTable} where client_id = $1 and float_id = $2 and ` + 
            `log_type in ($3, $4, $5, $6, $7, $8) order by updated_time desc`;
        const expectedValues = [testClientId, testFloatId, ...logTypes];

        const expectedResult = {
            'log_id': uuid(),
            'client_id': testClientId,
            'float_id': testFloatId,
            'creation_time': testCreationTime,
            'updated_time': moment().format(),
            'reference_time': moment().format(),
            'log_type': 'BALANCE_UNOBTAINABLE',
            'log_context': { resolved: false }
        };

        const finalResult = camelCaseKeys(expectedResult);

        queryStub.withArgs(expectedQuery, expectedValues).resolves([expectedResult, expectedResult, expectedResult]);

        const result = await persistence.getFloatAlerts(testClientId, testFloatId);
        logger('Got alerts:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([finalResult, finalResult, finalResult]);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Inserts float log', async () => {
        const testLogId = uuid();
        const testLogObject = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: '',
            logContext: { }
        };

        const insertQuery = `insert into ${floatLogTable} (log_id, client_id, float_id, log_type, log_context) values %L returning log_id`;
        const columnTemplate = '${logId}, ${clientId}, ${floatId}, ${logType}, ${logContext}';
        const logRow = { logId: sinon.match.string, ...testLogObject };

        insertRecordsStub.withArgs(insertQuery, columnTemplate, [logRow]).resolves({ 'command': 'INSERT', rows: [{ 'log_id': testLogId }]});

        const insertionResult = await persistence.insertFloatLog(testLogObject);
        logger('Result of log log insertion:', insertionResult);
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(testLogId);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(insertQuery, columnTemplate, [logRow]);
        
    });

    it('Updates float log', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'It is done.';

        const updateQuery = `update ${floatLogTable} set log_context = log_context || $1 where log_id = $2`;

        const testLogContext = {
            resolved: true,
            resolvedByUserId: testUserId,
            resolutionNote: testResolutionNote
        };

        const expectedResult = { 'command': 'UPDATE', 'rows': [{ 'updated_time': moment().format() }] };

        updateRecordStub.withArgs(updateQuery, [testLogContext, testLogId]).resolves(expectedResult);

        const updateResult = await persistence.updateFloatLog({ logId: testLogId, contextToUpdate: testLogContext});
        logger('Result of log update:', updateResult);
        logger('args', updateRecordStub.getCall(0).args);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(updateQuery, [testLogContext, testLogId]);

    });

    it('Gets float logs within period fetched successfully', async () => {
        const testLogTypes = ['BALANCE_MISMATCH', 'ALLOCATION_TOTAL_MISMATCH'];
        const expectedQuery = `select * from ${floatLogTable} where client_id = $1 and float_id = $2 ` +
            `and creation_time >= $3 and creation_time <= $4 and log_type in ($5, $6)`;
        const expectedValues = [testClientId, testFloatId, testStartTime, testEndTime, ...testLogTypes];

        const expectedResult = {
            'log_id': uuid(),
            'client_id': testClientId,
            'float_id': testFloatId,
            'creation_time': testCreationTime,
            'updated_time': moment().format(),
            'reference_time': moment().format(),
            'log_type': 'BALANCE_MISMATCH',
            'log_context': { resolved: false }
        };

        const finalResult = camelCaseKeys(expectedResult);

        queryStub.withArgs(expectedQuery, expectedValues).resolves([expectedResult, expectedResult, expectedResult]);

        const configForGetFloatLogsWithinPeriod = {
            clientId: testClientId,
            floatId: testFloatId,
            startTime: testStartTime,
            endTime: testEndTime,
            logTypes: testLogTypes
        };

        const result = await persistence.getFloatLogsWithinPeriod(configForGetFloatLogsWithinPeriod);
        logger('Got alerts:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([finalResult, finalResult, finalResult]);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Gets float logs within period handles no logs found', async () => {
        const testLogTypes = ['BALANCE_MISMATCH'];
        const expectedQuery = `select * from ${floatLogTable} where client_id = $1 and float_id = $2 ` +
            `and creation_time >= $3 and creation_time <= $4 and log_type in ($5)`;
        const expectedValues = [testClientId, testFloatId, testStartTime, testEndTime, ...testLogTypes];

        const expectedResult = null;
        const emptyArray = [];
        queryStub.withArgs(expectedQuery, expectedValues).resolves(emptyArray);

        const configForGetFloatLogsWithinPeriod = {
            clientId: testClientId,
            floatId: testFloatId,
            startTime: testStartTime,
            endTime: testEndTime,
            logTypes: testLogTypes
        };

        const result = await persistence.getFloatLogsWithinPeriod(configForGetFloatLogsWithinPeriod);
        logger('Got alerts:', result);

        expect(result).to.not.exist;
        expect(result).to.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });
});
