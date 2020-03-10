'use strict';

const logger = require('debug')('jupiter:user-messaging:rds-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const helper = require('./message.test.helper');

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
const momentStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.updateRecordObject = updateRecordStub;
        this.selectQuery = selectQueryStub;
        this.deleteRow = deleteRowStub;
        this.multiTableUpdateAndInsert = multiTableUpdateInsertStub;
    }
}

const instructionsRds = proxyquire('../persistence/rds.instructions', {
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
    momentStub.reset();
    uuidStub.reset();
};

describe('*** UNIT TESTING MESSAGE INSTRUCTION RDS UTIL ***', () => {
    const mockBoostId = uuid();
    const mockAudienceId = uuid();

    const instructionTable = config.get('tables.messageInstructionTable');
    const messageTable = config.get('tables.userMessagesTable');
    
    // bit of a hybrid but just to check all of it gets in
    const createPersistableInstruction = (instructionId) => ({
        instructionId: instructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: JSON.stringify({
            default: config.get('instruction.templates.default'),
            otherTemplates: null
        }),
        audienceId: mockAudienceId,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: JSON.stringify({ boostId: mockBoostId }),
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: '2060-11-11T11:47:41.596Z',
        messagePriority: 0,
        triggerContext: {
            triggerEvent: ['MANUAL_EFT_INITIATED'],
            haltingEvent: ['SAVING_PAYMENT_SUCCESSFUL'],
            messageSchedule: {
                type: 'FIXED',
                offset: { unit: 'day', number: 1 },
                fixed: { hour: 16, minute: 0 }
            }
        }
    });

    beforeEach(() => {
        resetStubs();
    });

    it('should insert message instruction', async () => {
        const mockInstructionId = uuid();

        const instructionObject = createPersistableInstruction(mockInstructionId);
        const instructionKeys = Object.keys(instructionObject);

        const mockInsertRecordsArgs = [
            `insert into ${config.get('tables.messageInstructionTable')} (${helper.extractQueryClause(instructionKeys)}) values %L returning instruction_id, creation_time`,
            helper.extractColumnTemplate(instructionKeys),
            [instructionObject]
        ];

        insertRecordsStub.withArgs(...mockInsertRecordsArgs).returns({ rows: [{ insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' }] });
        const expectedResult = [{ insertionId: 111, creationTime: '2049-06-22T07:38:30.016Z' }];

        const result = await instructionsRds.insertMessageInstruction(instructionObject);
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

        const result = await instructionsRds.getMessageInstruction(mockInstructionId);
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

        const result = await instructionsRds.getInstructionsByType('ALL_USERS', ['RECURRING'], ['READY_TO_SEND']);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

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
        const result = await instructionsRds.updateMessageInstruction(mockInstructionId, { active: false });
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
        const resultOfUpdate = await instructionsRds.updateInstructionState(mockInstructionId, 'READY_TO_SEND');
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

        const resultOfUpdate = await instructionsRds.alterInstructionMessageStates(mockInstructionId, ['CREATED'], 'READY_TO_SEND');
        logger('Result of message state update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([{ 'updated_time': mockUpdateTime }]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
        expect(multiTableUpdateInsertStub).to.have.been.calledOnceWithExactly(...multiInsertUpdateArgs);
    });

    it('Alters instruction message state and end time', async () => {
        const mockMessageId = uuid();
        const mockInstructionId = uuid();
        const mockUpdateTime = moment().format();
        const currentTime = moment();

        const mockSelectArgs = [
            `select message_id from ${config.get('tables.userMessagesTable')} where instruction_id = $1 and processed_status in ($2)`,
            [mockInstructionId, 'CREATED']
        ];

        const multiInsertUpdateArgs = [[{
            table: config.get('tables.userMessagesTable'),
            key: { messageId: mockMessageId },
            value: { processedStatus: 'READY_TO_SEND', endTime: currentTime.format() },
            returnClause: 'updated_time'
        }], []];

        selectQueryStub.withArgs(...mockSelectArgs).resolves([{ message_id: mockMessageId }]);
        multiTableUpdateInsertStub.withArgs(...multiInsertUpdateArgs).resolves([{ 'updated_time': mockUpdateTime }]);

        const resultOfUpdate = await instructionsRds.alterInstructionMessageStates(mockInstructionId, ['CREATED'], 'READY_TO_SEND', currentTime);
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

        const resultOfUpdate = await instructionsRds.alterInstructionMessageStates(mockInstructionId, ['CREATED'], 'READY_TO_SEND');
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
        const result = await instructionsRds.getCurrentInstructions();
        logger('Result of extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledWith(...firstSelectArgs);
        expect(selectQueryStub).to.have.been.calledWith(...secondSelectArgs);
    });
    
});

describe('*** UNIT TEST INSTRUCTION PICKING', async () => {

    const testInstructionId = uuid();

    beforeEach(() => resetStubs());

    it('Finds message instructions by event type', async () => {
        const expectedQuery = `select instruction_id, trigger_context from ${config.get('tables.messageInstructionTable')} where ` +
            `trigger_context -> 'triggerEvent' ? $1 and active = true and end_time > current_timestamp ` +
            `and presentation_type = $2 order by creation_time desc`;
        
        const mockContext = { triggerEvent: 'SAVING_PAYMENT_SUCCESSFUL' };
        const mockInstruction = { instructionId: testInstructionId, triggerContext: mockContext };

        selectQueryStub.resolves([{ 'instruction_id': testInstructionId, 'trigger_context': mockContext }]);

        const result = await instructionsRds.findMsgInstructionTriggeredByEvent('SAVING_PAYMENT_SUCCESSFUL');
        logger('Result of instruction extraction by flag:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([mockInstruction]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['SAVING_PAYMENT_SUCCESSFUL', 'EVENT_DRIVEN']);
    });

    it('Returns empty array where no instruction matches flag', async () => {
        const expectedQuery = `select instruction_id, trigger_context from ${config.get('tables.messageInstructionTable')} where ` +
            `trigger_context -> 'triggerEvent' ? $1 and active = true and end_time > current_timestamp ` +
            `and presentation_type = $2 order by creation_time desc`;
        selectQueryStub.resolves([]);

        const result = await instructionsRds.findMsgInstructionTriggeredByEvent('SAVING_PAYMENT_SUCCESSFUL');
        logger('Result of instruction extraction by flag:', result);

        expect(result).to.deep.equal([]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['SAVING_PAYMENT_SUCCESSFUL', 'EVENT_DRIVEN']);
    });

    it('Finds instructions that should be cancelled due to this event', async () => {
        // we want to be careful on this to definitely halt messages, so leave out remaining filters (e.g., active etc)
        // false positives here will be much less damaging to user perceptions than false negatives
        const expectedQuery = `select instruction_id from ${config.get('tables.messageInstructionTable')} where ` +
            `trigger_context -> 'haltingEvent' ? $1`;

        selectQueryStub.resolves([{ 'instruction_id': testInstructionId }]);

        const result = await instructionsRds.findMsgInstructionHaltedByEvent('SAVING_PAYMENT_SUCCESSFUL');

        expect(result).to.deep.equal([testInstructionId]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['SAVING_PAYMENT_SUCCESSFUL']);
    });

    it('Finds message for list of instructions and user id', async () => {
        const expectedQuery = `select message_id from message_data.user_message where ` +
            `instruction_id in ($1, $2) and processed_status in ($3, $4, $5, $6) and destination_user_id = $7`;
        const soughtStatuses = ['CREATED', 'SCHEDULED', 'READY_FOR_SENDING', 'SENDING'];

        selectQueryStub.resolves([{ 'message_id': 'some-message' }, { 'message_id': 'some-other-message' }]);

        const result = await instructionsRds.getMessageIdsForInstructions(['instruction-1', 'instruction-2'], 'user-1', soughtStatuses);

        expect(result).to.deep.equal(['some-message', 'some-other-message']);

        const expectedValues = ['instruction-1', 'instruction-2', ...soughtStatuses, 'user-1'];
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

});
