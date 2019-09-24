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
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

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
    const mockBoostId = uuid();

    const instructionTable = config.get('tables.messageInstructionTable');
    const accountTable = config.get('tables.accountLedger');

    const createPersistableInstruction = (instructionId) => ({
        instructionId: instructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: JSON.stringify({
            default: config.get('instruction.templates.default'),
            otherTemplates: null
        }),
        selectionInstruction: null,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: JSON.stringify({ boostId: mockBoostId }),
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: '2060-11-11T11:47:41.596Z',
        messagePriority: 0
    });

    beforeEach(() => {
        resetStubs();
    });

    it('should insert message instruction', async () => {
        const mockInstructionId = uuid();
   
        const instructionObject = createPersistableInstruction(mockInstructionId);
        const instructionKeys = Object.keys(instructionObject);

        const mockInsertRecordsArgs = [
            `insert into ${config.get('tables.messageInstructionTable')} (${extractQueryClause(instructionKeys)}) values %L returning instruction_id, creation_time`,
            extractColumnTemplate(instructionKeys),
            [instructionObject]
        ];
        logger('Created select args:', mockInsertRecordsArgs);

        insertRecordsStub.withArgs(...mockInsertRecordsArgs).returns({ rows: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] });
        const expectedResult = [ { insertionId: 111, creationTime: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.insertMessageInstruction(instructionObject);
        logger('Result of message instruction insertion:', result);
        logger('insert rec args:', insertRecordsStub.getCall(0).args);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertRecordsArgs);
    });

    it('should get message instruction', async () => {
        const mockInstructionId = uuid();
        const expectedQuery = `select * from ${instructionTable} where instruction_id = $1`;
        selectQueryStub.withArgs(expectedQuery, [mockInstructionId]).returns([createPersistableInstruction(mockInstructionId)]);
        const expectedResult = createPersistableInstruction(mockInstructionId);

        const result = await rdsUtil.getMessageInstruction(mockInstructionId);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockInstructionId]);
    });

    it('should get message instructions that match specified audience and presentation type', async () => {
        const mockInstructionId = uuid();
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
        const mockInstructionId = uuid();
        const mockUpdateRecordArgs = (instructionId) => [
            `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning instruction_id, update_time`,
            ['active', false, instructionId]
        ];
    
        updateRecordStub.withArgs(...mockUpdateRecordArgs(mockInstructionId)).returns({ rows: [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ] });
        const expectedResult = [ { insertionId: 111, updateTime: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.updateMessageInstruction(mockInstructionId, 'active', false);
        logger('Result of message instruction update (deactivation):', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateRecordArgs(mockInstructionId));
    });

    it('should get user ids', async () => {
        const mockClientId = uuid();
        const mockAccoutId = uuid();
        const mockSelectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
        const expectedQuery = `select account_id, owner_user_id from ${accountTable} where responsible_client_id = $1`;
        selectQueryStub.withArgs(expectedQuery, [mockClientId]).resolves([{ 'account_id': mockAccoutId, 'owner_user_id': mockAccoutId }]);

        const expectedResult = [ mockAccoutId ];

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockClientId]);
    });

    it('should get user ids where selection clause is random_sample', async () => {
        const mockPercentage = '0.33';
        const mockAccoutId = uuid();
        const mockSelectionInstruction = `random_sample #{${mockPercentage}}`;
        const mockSelectArgs = [
            'select owner_user_id from account_data.core_account_ledger tablesample bernoulli ($1)',
            [Number(mockPercentage.replace(/^0./, ''))]
        ];
        const mockSelectResult = [
            { 'account_id': mockAccoutId, 'owner_user_id': mockAccoutId },
            { 'account_id': mockAccoutId, 'owner_user_id': mockAccoutId },
            { 'account_id': mockAccoutId, 'owner_user_id': mockAccoutId }
        ];
        selectQueryStub.withArgs(...mockSelectArgs).resolves(mockSelectResult);

        const expectedResult = [ mockAccoutId, mockAccoutId, mockAccoutId ];

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('should throw an error on invalid row percentage in radom sample selection instruction', async () => {
        const mockClientId = uuid();
        const mockPercentage = 'half';
        const mockSelectionInstruction = `random_sample #{${mockPercentage}} from #{{"client_id":"${mockClientId}"}}`;

        const expectedResult = 'Invalid row percentage.';
        await expect(rdsUtil.getUserIds(mockSelectionInstruction)).to.be.rejectedWith(expectedResult);
    });

    it('should insert user messages', async () => {
        const mockAccoutId = uuid();
        const mockInstructionId = uuid();
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
            { 'insertion_id': 99, 'creation_time': mockCreationTime },
            { 'insertion_id': 100, 'creation_time': mockCreationTime }, { 'insertion_id': 101, 'creation_time': mockCreationTime }
        ];
        multiTableStub.withArgs([mockInsertionArgs]).resolves([insertionResult]);

        const expectedResult = [
            { 'insertionId': 99, 'creationTime': mockCreationTime },
            { 'insertionId': 100, 'creationTime': mockCreationTime }, { 'insertionId': 101, 'creationTime': mockCreationTime }
        ];

        const result = await rdsUtil.insertUserMessages(mockRows, rowObjectKeys);
        logger('Result of bulk user message insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
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
        const mockPersistableToken = {
            userId: mockUserId,
            pushProvider: mockProvider,
            pushToken: mockPushToken
        };

        const mockInsertionArgs = [ 
            `insert into ${config.get('tables.pushTokenTable')} (${extractQueryClause(Object.keys(mockPersistableToken))}) values %L returning insertion_id, creation_time`,
            extractColumnTemplate(Object.keys(mockPersistableToken)),
            [ mockPersistableToken ]
        ];

        insertRecordsStub.withArgs(...mockInsertionArgs).resolves({ rows: [{ 'insertion_id': 1, 'creation_time': mockCreationTime }] });
        const expectedResult = [{ 'insertionId': 1, 'creationTime': mockCreationTime }];

        const result = await rdsUtil.insertPushToken(mockPersistableToken);
        logger('Result of push token insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertionArgs);
    });

    it('should get push token', async () => {
        const mockPersistedToken = [{
            'insertion_id': 1,
            'creation_time': mockCreationTime,
            'user_id': mockUserId,
            'push_provider': mockProvider,
            'push_token': mockPushToken,
            'active': true
        }];

        const mockSelectArgs = [
            `select * from ${config.get('tables.pushTokenTable')} where push_provider = $1 and user_id = $2`,
            [ mockProvider, mockUserId ]
        ];

        selectQueryStub.withArgs(...mockSelectArgs).resolves(mockPersistedToken);

        const expectedResult = camelCaseKeys(mockPersistedToken[0]);

        const result = await rdsUtil.getPushToken(mockProvider, mockUserId);
        logger('Result of push token extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('should deactivate push token', async () => {
        
        const mockUpdateArgs = [
            `update ${config.get('tables.pushTokenTable')} set active = false where push_provider = $1 and user_id = $2 returning insertion_id, update_time`,
            [ mockProvider, mockUserId ]
        ];

        updateRecordStub.withArgs(...mockUpdateArgs).resolves({
            command: 'UPDATE',
            rowCount: 1,
            oid: null,
            rows: [ { insertion_id: 2, update_time: mockUpdateTime } ]
        });

        const expectedResult = [ { insertionId: 2, updateTime: mockUpdateTime } ];

        const result = await rdsUtil.deactivatePushToken(mockProvider, mockUserId);
        logger('Result of push token deactivation:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateArgs);
    });

    it('should delete push token', async () => {
        
        // observe during integration tests
        const mockDeleteRowArgs = [
            config.get('tables.pushTokenTable'),
            [ 'push_provider', 'user_id' ],
            [ mockProvider, mockUserId ]
        ];

        deleteRowStub.resolves({
            command: 'DELETE',
            rowCount: 1,
            oid: null,
            rows: []
        });

        const expectedResult = [];

        const result = await rdsUtil.deletePushToken(mockProvider, mockUserId);
        logger('Result of push token deletion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(deleteRowStub).to.have.been.calledOnceWithExactly(...mockDeleteRowArgs);
    });
});
