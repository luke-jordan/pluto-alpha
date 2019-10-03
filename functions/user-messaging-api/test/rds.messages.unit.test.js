'use strict';

const logger = require('debug')('jupiter:user-messaging:rds-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const decamelize = require('decamelize');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const multiTableUpdateInsertStub = sinon.stub();
const insertRecordsStub = sinon.stub();
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();
const deleteRowStub = sinon.stub();
const multiTableStub = sinon.stub();
const momentStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.updateRecordObject = updateRecordStub;
        this.selectQuery = selectQueryStub;
        this.deleteRow = deleteRowStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiTableUpdateInsertStub;
    }
}

const rdsUtil = proxyquire('../persistence/rds.notifications', {
    'rds-common': MockRdsConnection,
    'moment': momentStub,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => {
    multiTableUpdateInsertStub.reset();
    insertRecordsStub.reset();
    updateRecordStub.reset();
    selectQueryStub.reset();
    deleteRowStub.reset();
    multiTableStub.reset();
    momentStub.reset();
    uuidStub.reset();
};

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

describe('*** UNIT TESTING MESSAGGE INSTRUCTION RDS UTIL ***', () => {
    const mockBoostId = uuid();

    const instructionTable = config.get('tables.messageInstructionTable');
    const boostAccountTable = config.get('tables.boostAccountTable');
    const messageTable = config.get('tables.userMessagesTable');
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

        insertRecordsStub.withArgs(...mockInsertRecordsArgs).returns({ rows: [{ insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' }] });
        const expectedResult = [{ insertionId: 111, creationTime: '2049-06-22T07:38:30.016Z' }];

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
            `select * from ${config.get('tables.messageInstructionTable')} where presentation_type = $1 and active = true and end_time > current_timestamp and audience_type in ($2) and processed_status in ($3)`,
            ['ALL_USERS', 'RECURRING', 'READY_TO_SEND']
        ];
        selectQueryStub.withArgs(...mockSelectArgs).returns([mockInstruction, mockInstruction, mockInstruction]);
        const expectedResult = [mockInstruction, mockInstruction, mockInstruction];

        const result = await rdsUtil.getInstructionsByType('ALL_USERS', ['RECURRING'], ['READY_TO_SEND']);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    // it('****', async () => {
    //     const mockInstructionId = uuid();
    //     const mockInstruction = createPersistableInstruction(mockInstructionId);
    //     const mockSelectArgs = [
    //         `select * from ${config.get('tables.messageInstructionTable')} where presentation_type = $1 and active = true and end_time > current_timestamp and audience_type in ($2) and processed_status in ($3)`,
    //         ['ALL_USERS', 'RECURRING', 'READY_TO_SEND']
    //     ];
    //     selectQueryStub.withArgs(...mockSelectArgs).returns([mockInstruction, mockInstruction, mockInstruction]);
    //     const expectedResult = [mockInstruction, mockInstruction, mockInstruction];

    //     const result = await rdsUtil.getInstructionsByType('ALL_USERS', ['RECURRING'], ['READY_TO_SEND']);
    //     logger('Result of instruction extraction from db:', result);

    //     expect(result).to.exist;
    //     expect(result).to.deep.equal(expectedResult);
    //     expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    // });

    it('should update message instruction', async () => {
        const mockInstructionId = uuid();
        const mockUpdateRecordArgs = {
            table: config.get('tables.messageInstructionTable'),
            key: { instructionId: mockInstructionId },
            value: { active: false },
            returnClause: 'updated_time'
        };
    
        updateRecordStub.withArgs(mockUpdateRecordArgs).returns([{ update_time: '2049-06-22T07:38:30.016Z' }]);
        const expectedResult = [{ updateTime: '2049-06-22T07:38:30.016Z' }];

        // sync with new imlementation
        const result = await rdsUtil.updateMessageInstruction(mockInstructionId, { active: false });
        logger('Result of message instruction update (deactivation):', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(mockUpdateRecordArgs);
    });

    it('Updates instruction state', async () => {
        const mockInstructionId = uuid();
        const mockCurrentTime = moment().format();
        const mockUpdateRecordArgs = {
            table: config.get('tables.messageInstructionTable'),
            key: { instructionId: mockInstructionId },
            value: { processedStatus: 'READY_TO_SEND', lastProcessedTime: mockCurrentTime },
            returnClause: 'updated_time'
        };
    
        momentStub.returns({ format: () => mockCurrentTime });
        updateRecordStub.withArgs(mockUpdateRecordArgs).returns([{ 'update_time': '2049-06-22T07:38:30.016Z' }]);
        
        // sync with new imlementation
        const resultOfUpdate = await rdsUtil.updateInstructionState(mockInstructionId, 'READY_TO_SEND');
        logger('Result of message instruction update:', resultOfUpdate);
       
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([{ updateTime: '2049-06-22T07:38:30.016Z' }]);
        expect(momentStub).to.have.been.calledOnce;
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(mockUpdateRecordArgs);
    });

    it('Alters instruction message state', async () => {
        const mockMessageId = uuid();
        const mockInstructionId = uuid();
        const mockUpdateTime = moment().format();

        const mockSelectArgs = [
            `select message_id from ${config.get('tables.userMessagesTable')} where instruction_id = $1 and processed_status in ($2)`,
            [mockInstructionId, 'CREATED']
        ];

        const multiInsertUpdateArgs = [[{
            table: config.get('tables.userMessagesTable'),
            key: { messageId: mockMessageId },
            value: { processedStatus: 'READY_TO_SEND' },
            returnClause: 'updated_time'
        }], []];

        selectQueryStub.withArgs(...mockSelectArgs).resolves([{ message_id: mockMessageId }]);
        multiTableUpdateInsertStub.withArgs(...multiInsertUpdateArgs).resolves([{ 'updated_time': mockUpdateTime }]);

        const resultOfUpdate = await rdsUtil.alterInstructionMessageStates(mockInstructionId, ['CREATED'], 'READY_TO_SEND');
        logger('Result of message state update:', resultOfUpdate);
    
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([{ 'updated_time': mockUpdateTime }]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
        expect(multiTableUpdateInsertStub).to.have.been.calledOnceWithExactly(...multiInsertUpdateArgs);
    });

    it('Gracefully exists where no messages to update are found', async () => {
        const mockInstructionId = uuid();
        const mockSelectArgs = [
            `select message_id from ${config.get('tables.userMessagesTable')} where instruction_id = $1 and processed_status in ($2)`,
            [mockInstructionId, 'CREATED']
        ];

        selectQueryStub.withArgs(...mockSelectArgs).resolves([]);

        const resultOfUpdate = await rdsUtil.alterInstructionMessageStates(mockInstructionId, ['CREATED'], 'READY_TO_SEND');
        logger('Result of message state update:', resultOfUpdate);
    
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.equal('NO_MESSAGES_TO_UPDATE');
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
        expect(multiTableUpdateInsertStub).to.have.not.been.called;
    });

    it('Gets current instruction', async () => {
        const mockInstructionId = uuid();
        const firstSelectArgs = [
            `select instruction.instruction_id, count(message_id) as unfetched_message_count from ${instructionTable} as instruction inner join ${messageTable} as messages on instruction.instruction_id = messages.instruction_id where messages.processed_status not in ($1, $2, $3, $4, $5) group by instruction.instruction_id`,
            ['FETCHED', 'SENT', 'DELIVERED', 'DISMISSED', 'UNDELIVERABLE']
        ];
        const secondSelectArgs = [
            `select instruction.*, count(message_id) as total_message_count from ${instructionTable} as instruction left join ${messageTable} as messages on instruction.instruction_id = messages.instruction_id where (instruction.active = true and instruction.end_time > current_timestamp) group by instruction.instruction_id`,
            []
        ];
        const expectedResult = [{
            instructionId: mockInstructionId,
            totalMessageCount: 5,
            unfetchedMessageCount: 6
        }];

        selectQueryStub.withArgs(...firstSelectArgs).resolves([{ instruction_id: mockInstructionId, unfetched_message_count: 6 }]);
        selectQueryStub.withArgs(...secondSelectArgs).resolves([{ instruction_id: mockInstructionId, total_message_count: 5 }]);
        const result = await rdsUtil.getCurrentInstructions();
        logger('Result of extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledWith(...firstSelectArgs);
        expect(selectQueryStub).to.have.been.calledWith(...secondSelectArgs);
    });

    // //////////////////////////////////////////////////////////////////////////////////
    // ///////////////////////// TO BE SEPERATED ////////////////////////////////////////
    // //////////////////////////////////////////////////////////////////////////////////

    it('should get user ids', async () => {
        const mockClientId = uuid();
        const mockAccountId = uuid();
        const mockSelectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
        const expectedQuery = `select account_id, owner_user_id from ${accountTable} where responsible_client_id = $1`;
        selectQueryStub.withArgs(expectedQuery, [mockClientId]).resolves([{ 'account_id': mockAccountId, 'owner_user_id': mockAccountId }]);

        const expectedResult = [mockAccountId];

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockClientId]);
    });

    it('should get user ids (on float_id universe selection)', async () => {
        const mockFloatId = uuid();
        const mockAccountId = uuid();
        const mockSelectionInstruction = `whole_universe from #{{"float_id":"${mockFloatId}"}}`;
        const expectedQuery = `select account_id, owner_user_id from ${accountTable} where float_id = $1`;
        selectQueryStub.withArgs(expectedQuery, [mockFloatId]).resolves([{ 'account_id': mockAccountId, 'owner_user_id': mockAccountId }]);

        const expectedResult = [mockAccountId];

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockFloatId]);
    });

    it('should get user ids (on specific_accounts universe selection)', async () => {
        const mockAccountId = uuid();
        const mockSelectionInstruction = `whole_universe from #{{"specific_accounts":["${mockAccountId}","${mockAccountId}"]}}`;
        const expectedQuery = `select account_id, owner_user_id from ${accountTable} where owner_user_id in ($1, $2)`;
        selectQueryStub.withArgs(expectedQuery, [mockAccountId, mockAccountId]).resolves([{ 'account_id': mockAccountId, 'owner_user_id': mockAccountId }]);

        const expectedResult = [mockAccountId];

        const result = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockAccountId, mockAccountId]);
    });

    it('should get user ids where selection clause is random_sample', async () => {
        const mockPercentage = '0.33';
        const mockAccountId = uuid();
        const mockSelectionInstruction = `random_sample #{${mockPercentage}}`;
        const mockSelectArgs = [
            'select owner_user_id from account_data.core_account_ledger tablesample bernoulli ($1)',
            [Number(mockPercentage.replace(/^0./, ''))]
        ];
        const mockSelectResult = [
            { 'owner_user_id': mockAccountId },
            { 'owner_user_id': mockAccountId },
            { 'owner_user_id': mockAccountId }
        ];
        selectQueryStub.withArgs(...mockSelectArgs).resolves(mockSelectResult);

        const expectedResult = [mockAccountId, mockAccountId, mockAccountId];

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

    it('Selects users that match another entity', async () => {
        const mockUserId = uuid();
        const mockEntityId = uuid();
        const mockSelectionInstruction = `match_other from #{{"entityType":"boost","entityId":"${mockEntityId}"}}`;

        const mockSelectArgs = [
            `select distinct(owner_user_id) from ${accountTable} inner join ${boostAccountTable} on ${accountTable}.account_id = ${boostAccountTable}.account_id where boost_id = $1`,
            [mockEntityId]
        ];

        const mockSelectResult = [
            { 'owner_user_id': mockUserId },
            { 'owner_user_id': mockUserId },
            { 'owner_user_id': mockUserId }
        ];
        selectQueryStub.withArgs(...mockSelectArgs).resolves(mockSelectResult);

        const fetchResult = await rdsUtil.getUserIds(mockSelectionInstruction);
        logger('got this back from user id extraction:', fetchResult);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal([mockUserId, mockUserId, mockUserId]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('Fails on unimplemented matching entity', async () => {
        const mockEntityId = uuid();
        const mockSelectionInstruction = `match_other from #{{"entityType":"games","entityId":"${mockEntityId}"}}`;
        await expect(rdsUtil.getUserIds(mockSelectionInstruction)).to.be.rejectedWith('Unimplemented matching entity');
        expect(selectQueryStub).to.have.not.been.called;
    });

    it('Fails on invalid selection method', async () => {
        const mockClientId = uuid();
        const mockSelectionInstruction = `parallel_universe from #{{"client_id":"${mockClientId}"}}`;
        await expect(rdsUtil.getUserIds(mockSelectionInstruction)).to.be.rejectedWith('Invalid selection method provided: parallel_universe');
        expect(selectQueryStub).to.have.not.been.called;
    });

    // it.only('Fails on invalid universe definition', async () => {
    //     const mockClientId = uuid();
    //     const mockSelectionInstruction = `whole_universe from #{'"client_id"'}`;
    //     // await expect(rdsUtil.getUserIds(mockSelectionInstruction)).to.be.rejectedWith('Invalid selection method provided: parallel_universe');
    //     const result = await rdsUtil.getUserIds(mockSelectionInstruction);
    //     logger('Result:', result);
    // });

    it('should insert user messages', async () => {
        const mockAccountId = uuid();
        const mockInstructionId = uuid();
        const mockCreationTime = moment().format();
        const row = {
            destinationUserId: mockAccountId,
            instructionId: mockInstructionId,
            message: 'Welcome to Jupiter Savings.',
            presentationInstruction: null
        };
        const mockRows = [row, row, row];
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

describe('*** UNIT TEST USER ID RECURRENCE FILTER ***', () => {
    
    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockMinIntervalDays = 5;
    const mockMaxInQueue = 5;

    const mockDurationClause = moment().subtract(mockMinIntervalDays, 'days');

    beforeEach(() => {
        resetStubs();
        momentStub.returns({ subtract: () => mockDurationClause, format: () => mockDurationClause.format() });
    });

    it('Finds user ids that are not disqualified by recurrence parameters', async () => {
        const mockUnfilteredId = uuid();
        const minIntervalSelectArgs = [
            `select distinct(destination_user_id) from ${config.get('tables.userMessagesTable')} where instruction_id = $1 and creation_time > $2`,
            [mockInstructionId, mockDurationClause.format()]
        ];

        const queueSizeSelectArgs = [
            `select destination_user_id from ${config.get('tables.userMessagesTable')} where processed_status = $1 group by destination_user_id having count(*) > $2`,
            ['READY_FOR_SENDING', mockMaxInQueue]
        ];

        selectQueryStub.withArgs(...minIntervalSelectArgs).resolves([{ 'destination_user_id': mockUserId }, { 'destination_user_id': mockUserId }]);
        selectQueryStub.withArgs(...queueSizeSelectArgs).resolves([{ 'destination_user_id': mockUserId }, { 'destination_user_id': mockUserId }]);

        const mockEvent = [[mockUserId, mockUnfilteredId], { instructionId: mockInstructionId, recurrenceParameters: { minIntervalDays: mockMinIntervalDays, maxInQueue: mockMaxInQueue } }];

        const resultOfFilter = await rdsUtil.filterUserIdsForRecurrence(...mockEvent);
        logger('Result of filter:', resultOfFilter);

        expect(resultOfFilter).to.exist;
        expect(resultOfFilter).to.deep.equal([mockUnfilteredId]);
        expect(selectQueryStub).to.have.been.calledWith(...minIntervalSelectArgs);
        expect(selectQueryStub).to.have.been.calledWith(...queueSizeSelectArgs);
    });

});

describe('*** UNIT TESTING PUSH TOKEN RDS FUNCTIONS ***', () => {
    const mockUserId = uuid();
    const mockPushToken = uuid();
    const mockProvider = uuid();
    const mockCreationTime = '2030-01-01T00:00:01.016Z';
    
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
            [mockPersistableToken]
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
        const mockSelectArgs = [
            `select user_id, push_token from ${config.get('tables.pushTokenTable')} where active = true and push_provider = $1 and  user_id in ($2) order by creation_time asc`,
            [mockProvider, mockUserId]
        ];

        selectQueryStub.withArgs(...mockSelectArgs).resolves([{ 'user_id': mockUserId, 'push_token': mockPushToken }]);

        const expectedResult = { [mockUserId]: mockPushToken };

        const result = await rdsUtil.getPushTokens([mockUserId], mockProvider);
        logger('Result of push token extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('should deactivate push token', async () => {
        const mockUpdateArgs = [{
            table: config.get('tables.pushTokenTable'),
            key: { userId: mockUserId,
            provider: mockProvider },
            value: undefined,
            returnClause: 'insertion_time'
        }];

        updateRecordStub.withArgs(...mockUpdateArgs).resolves([{ insertion_id: 2 }]);

        const result = await rdsUtil.deactivatePushToken(mockProvider, mockUserId);
        logger('Result of push token deactivation:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([{ insertionId: 2 }]);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateArgs);
    });

    it('should delete push token', async () => {
        
        // observe during integration tests
        const mockDeleteRowArgs = [
            config.get('tables.pushTokenTable'),
            ['push_provider', 'user_id'],
            [mockProvider, mockUserId]
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
