'use strict';

const logger = require('debug')('jupiter:user-notifications:rds-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');
const decamelize = require('decamelize');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');

const insertRecordsStub = sinon.stub();
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();
const multiTableStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.updateRecord = updateRecordStub;
        this.selectQuery = selectQueryStub;
        this.largeMultiTableInsert = multiTableStub;
    }
}

const rdsUtil = proxyquire('../persistence/rds.notifications', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => {
    insertRecordsStub.reset();
    updateRecordStub.reset();
    selectQueryStub.reset();
    multiTableStub.reset();
    uuidStub.reset();
};

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');


describe('*** UNIT TESTING MESSAGGE INSTRUCTION RDS UTIL ***', () => {
    const mockInstructionId = uuid();
    const mockClientId = uuid();
    const mockBoostId = uuid();
    const mockAccoutId = uuid();

    const instructionTable = config.get('tables.messageInstructionTable');
    const accountTable = config.get('tables.accountLedger');

    const createPersistableInstruction = (instructionId) => ({
        instructionId: instructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: {
            default: config.get('instruction.templates.default'),
            otherTemplates: null
        },
        selectionInstruction: null,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: mockBoostId },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: '2060-11-11T11:47:41.596Z',
        messagePriority: 0
    });

    // legacy implementation tests whether new implementation achieved same result.
    const insertionQueryArray = [
        'instruction_id',
        'presentation_type',
        'active',
        'audience_type',
        'templates',
        'selection_instruction',
        'recurrence_instruction',
        'response_action',
        'response_context',
        'start_time',
        'end_time',
        'last_processed_time',
        'message_priority' 
    ];

    const mockInsertRecordsArgs = (instructionId) => [
        `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning instruction_id, creation_time`,
        '${instructionId}, ${presentationType}, ${active}, ${audienceType}, ${templates}, ${selectionInstruction}, ${recurrenceInstruction}, ${responseAction}, ${responseContext}, ${startTime}, ${endTime}, ${lastProcessedTime}, ${messagePriority}',
        [createPersistableInstruction(instructionId)]
    ];

    const mockUpdateRecordArgs = (instructionId) => [
        `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning instruction_id, update_time`,
        ['active', false, instructionId]
    ];
    
    const mockSelectQueryArgs = (table, property, value, condition) => [
        `select ${property} from ${table} where ${condition} = $1`,
        [value]
    ];

    beforeEach(() => {
        resetStubs();
    });

    it('should insert message instruction', async () => {
        const mockPersistableInstruction = createPersistableInstruction(mockInstructionId);
        insertRecordsStub.withArgs(...mockInsertRecordsArgs(mockInstructionId)).returns({ rows: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] });
        const expectedResult = [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.insertMessageInstruction(mockPersistableInstruction);
        logger('Result of message instruction insertion:', result);
        logger('insert rec args:', insertRecordsStub.getCall(0).args);
        logger('expected:', mockInsertRecordsArgs(mockInstructionId));

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertRecordsArgs(mockInstructionId));
    });

    it('should get message instruction', async () => {
        selectQueryStub.withArgs(...mockSelectQueryArgs(instructionTable, '*', mockInstructionId, 'instruction_id')).returns([createPersistableInstruction(mockInstructionId)]);
        const expectedResult = createPersistableInstruction(mockInstructionId);

        const result = await rdsUtil.getMessageInstruction(mockInstructionId);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(instructionTable, '*', mockInstructionId, 'instruction_id'));
    });

    it('should get message instructions that match specified audience and presentation type', async () => {
        const mockInstruction = createPersistableInstruction(mockInstructionId);
        const mockSelectArgs = [
            `select * from ${config.get('tables.messageInstructionTable')} where audience_type = $1 and presentation_type = $2 and active = true`,
            ['ALL_USERS', 'RECURRING']
        ];
        selectQueryStub.withArgs(...mockSelectArgs).returns([mockInstruction, mockInstruction, mockInstruction]);
        const expectedResult = [mockInstruction, mockInstruction, mockInstruction];

        const result = await rdsUtil.getInstructionsByType('ALL_USERS', 'RECURRING');
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('should update message instruction', async () => {
        updateRecordStub.withArgs(...mockUpdateRecordArgs(mockInstructionId)).returns({ rows: [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ] });
        const expectedResult = [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.updateMessageInstruction(mockInstructionId, 'active', false);
        logger('Result of message instruction update (deactivation):', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateRecordArgs(mockInstructionId));
    });

    it('should get user ids', async () => {
        const mockSelectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
        const expectedQuery = `select account_id, owner_user_id from ${accountTable} where responsible_client_id = $1`;
        selectQueryStub.withArgs(expectedQuery, [mockClientId]).resolves([{ 'account_id': mockAccoutId, 'owner_user_id': mockAccoutId }]);
        // selectQueryStub.withArgs(...mockSelectQueryArgs(accountTable, 'account_id', mockClientId, 'client_id')).resolves([ 
        //     { 'account_id': mockAccoutId }, { 'account_id': mockAccoutId }, { 'account_id': mockAccoutId }
        // ]);
        const expectedResult = [ mockAccoutId ];

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockClientId]);
        // expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(accountTable, 'account_id', mockClientId, 'client_id'));
    });

    it('should insert user messages', async () => {
        const mockCreationTime = moment().format();
        const row = {
            destinationUserId: mockAccoutId,
            instructionId: mockInstructionId,
            message: 'Welcome to Jupiter Savings.',
            presentationInstruction: null
        };
        const mockRows = [ row, row, row ];
        const rowObjectKeys = Object.keys(row);
        const mockInsertionArgs = {
            query: `insert into ${config.get('tables.userMessagesTable')} (${extractQueryClause(rowObjectKeys)}) values %L returning message_id, creation_time`,
            columnTemplate: extractColumnTemplate(rowObjectKeys),
            rows: mockRows
        };
        const insertionResult = [
            [{ 'insertion_id': 99, 'creation_time': mockCreationTime },
            { 'insertion_id': 100, 'creation_time': mockCreationTime }, { 'insertion_id': 101, 'creation_time': mockCreationTime }]
        ];
        multiTableStub.withArgs([mockInsertionArgs]).resolves(insertionResult);

        const result = await rdsUtil.insertUserMessages(mockRows, rowObjectKeys);
        logger('Result of bulk user message insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(insertionResult);
        expect(multiTableStub).to.have.been.calledOnceWithExactly([mockInsertionArgs]);
    });
});
