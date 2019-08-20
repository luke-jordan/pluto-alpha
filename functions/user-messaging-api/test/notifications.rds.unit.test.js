'use strict';

const logger = require('debug')('jupiter:user-notifications:rds-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const decamelize = require('decamelize');
const camelcase = require('camelcase');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');

const insertRecordsStub = sinon.stub();
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();
const deleteRowStub = sinon.stub();
const multiTableStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.updateRecord = updateRecordStub;
        this.selectQuery = selectQueryStub;
        this.deleteRow = deleteRowStub;
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
    deleteRowStub.reset();
    multiTableStub.reset();
    uuidStub.reset();
};

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');
const camelCaseKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [camelcase(key)]: object[key] }), {});


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
<<<<<<< HEAD
        selectQueryStub.withArgs(...mockSelectQueryArgs(accountTable, 'owner_user_id', mockClientId, 'client_id')).resolves([ 
            { 'owner_user_id': mockAccoutId }, { 'owner_user_id': mockAccoutId }, { 'owner_user_id': mockAccoutId }
        ]);
        const expectedResult = [ mockAccoutId, mockAccoutId, mockAccoutId ];
=======
        const expectedQuery = `select account_id, owner_user_id from ${accountTable} where responsible_client_id = $1`;
        selectQueryStub.withArgs(expectedQuery, [mockClientId]).resolves([{ 'account_id': mockAccoutId, 'owner_user_id': mockAccoutId }]);
        // selectQueryStub.withArgs(...mockSelectQueryArgs(accountTable, 'account_id', mockClientId, 'client_id')).resolves([ 
        //     { 'account_id': mockAccoutId }, { 'account_id': mockAccoutId }, { 'account_id': mockAccoutId }
        // ]);
        const expectedResult = [ mockAccoutId ];
>>>>>>> wip-boosts-dev

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
<<<<<<< HEAD
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(accountTable, 'owner_user_id', mockClientId, 'client_id'));
=======
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockClientId]);
        // expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(accountTable, 'account_id', mockClientId, 'client_id'));
>>>>>>> wip-boosts-dev
    });

    // it('should get user ids where selection clause is random_sample:', async () => {
    //     const mockSelectionInstruction = 'random_sample #{0.33} from #{{"client_id":"${mockClientId}"}}';

    //     const result = await rdsUtil.getUserIds(mockSelectionInstruction);
    //     logger('got this back from user id extraction:', result);
    // });

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

describe('*** UNIT TESTING PUSH TOKEN RDS FUNCTIONS ***', () => {
    const mockUserId = uuid();
    const mockPushToken = uuid();
    const mockProvider = uuid();
    const mockCreationTime = '2030-01-01T00:00:01.016Z';
    const mockUpdateTime = '2030-01-01T00:00:02.016Z';

    beforeEach(() => {
        resetStubs();
    });

    it('should persist push token', async () => {
        const mockTokenObject = {
            userId: mockUserId,
            pushProvider: mockProvider,
            pushToken: mockPushToken
        };

        const mockInsertionArgs = [ 
            `insert into ${config.get('tables.pushTokenTable')} (${extractQueryClause(Object.keys(mockTokenObject))}) values %L returning insertion_id, creation_time`,
            extractColumnTemplate(Object.keys(mockTokenObject)),
            [ mockTokenObject ]
        ];

        insertRecordsStub.withArgs(...mockInsertionArgs).resolves({ rows: [{ insertion_id: 1, creation_time: mockCreationTime }] });
        const expectedResult = [{ insertion_id: 1, creation_time: mockCreationTime }];

        const result = await rdsUtil.insertPushToken(mockTokenObject);
        logger('Result of push token insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertionArgs);
    });

    it('should get push token', async () => {
        const mockPersistedToken = [{
            insertion_id: 1,
            creation_time: mockCreationTime,
            user_id: mockUserId,
            push_provider: mockProvider,
            push_token: mockPushToken,
            active: true
        }];
        const mockSelectArgs = [
            `select * from ${config.get('tables.pushTokenTable')} where push_provider = $1`,
            [ mockProvider ]
        ];

        selectQueryStub.withArgs(...mockSelectArgs).resolves(mockPersistedToken);

        const expectedResult = camelCaseKeys(mockPersistedToken[0]);

        const result = await rdsUtil.getPushToken(mockProvider);
        logger('Result of push token extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('should deactivate push token', async () => {
        
        const mockUpdateArgs = [
            `update ${config.get('tables.pushTokenTable')} set active = false where push_provider = $1 returning insertion_id, update_time`,
            [ mockProvider ]
        ];

        updateRecordStub.withArgs(...mockUpdateArgs).resolves({
            command: 'UPDATE',
            rowCount: 1,
            oid: null,
            rows: [ { insertion_id: 2, update_time: mockUpdateTime } ]
        });

        const expectedResult = [ { insertion_id: 2, update_time: mockUpdateTime } ];

        const result = await rdsUtil.deactivatePushToken(mockProvider);
        logger('Result of push token deactivation:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateArgs);
    });

    it('should delete push token', async () => {
        
        const mockDeleteRowArgs = [
            config.get('tables.pushTokenTable'),
            [ 'push_provider'],
            [ mockProvider ]
        ];

        deleteRowStub.withArgs(...mockDeleteRowArgs).resolves({
            command: 'DELETE',
            rowCount: 1,
            oid: null,
            rows: []
        });

        const expectedResult = [];

        const result = await rdsUtil.deletePushToken(mockProvider);
        logger('Result of push token deletion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(deleteRowStub).to.have.been.calledOnceWithExactly(...mockDeleteRowArgs);
    });
});
