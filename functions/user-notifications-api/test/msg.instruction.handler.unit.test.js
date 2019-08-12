'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instruction-test');
const uuid = require('uuid/v4');
const config = require('config');
const sinon = require('sinon');

const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');

const insertRecordsStub = sinon.stub();
const uuidStub = sinon.stub();
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.updateRecord = updateRecordStub;
        this.selectQuery = selectQueryStub;
    }
}

const handler = proxyquire('../msg-instruction-handler', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub, 
    '@noCallThru': true
});


const resetStubs = () => {
    insertRecordsStub.reset();
    updateRecordStub.reset();
    selectQueryStub.reset();
    uuidStub.reset();
};

describe('*** UNIT TESTING MESSAGE INSTRUCTION INSERTION ***', () => {
    
    const mockInstructionId = uuid();

    const mockEvent = {
        presentationType: 'ONCE_OFF',
        audienceType: 'ALL_USERS',
        defaultTemplate: config.get('templates.default'),
        otherTemplates: null,
        selectionInstruction: null,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: uuid() },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        priority: 0
    };

    const resetEvent = () => {
        mockEvent.presentationType = 'ONCE_OFF';
        mockEvent.audienceType = 'ALL_USERS';
        mockEvent.defaultTemplate = config.get('templates.default');
    };

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
        'priority' 
    ];

    const mockInsertRecordsArgs = [
        `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`,
        '${instructionId}, ${presentationType}, ${active}, ${audienceType}, ${templates}, ${selectionInstruction}, ${recurrenceInstruction}, ${responseAction}, ${responseContext}, ${startTime}, ${endTime}, ${priority}',
        [{
            instructionId: mockInstructionId,
            presentationType: mockEvent.presentationType,
            active: true,
            audienceType: mockEvent.audienceType,
            templates: { default: mockEvent.defaultTemplate, otherTemplates: mockEvent.otherTemplates },
            selectionInstruction: mockEvent.selectionInstruction,
            recurrenceInstruction: mockEvent.recurrenceInstruction,
            responseAction: mockEvent.responseAction,
            responseContext: mockEvent.responseContext,
            startTime: mockEvent.startTime,
            endTime: mockEvent.endTime,
            priority: mockEvent.priority
        }]
    ]

    beforeEach(() => {
        resetStubs();
        resetEvent();
        uuidStub.returns(mockInstructionId);
    });

    it('should insert new message intruction', async () => {
        insertRecordsStub.withArgs(...mockInsertRecordsArgs).returns({ rows: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] });

        const expectedResult = { message: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] };

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', result);
        logger('mockInstructionId:', mockInstructionId);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertRecordsArgs);
    });

    it('it should throw an error on missing recurrance instruction where presentation type is RECURRING', async () => {
        const expectedResult = { message: 'recurrenceInstruction is required where presentationType is set to RECURRING.' };

        mockEvent.presentationType = 'RECURRING';
        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required recurrance instruction:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on individual notification', async () => {
        const expectedResult = { message: 'selectionInstruction required on indivdual notification.' };

        mockEvent.audienceType = 'INDIVIDUAL';
        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on group notification', async () => {
        const expectedResult = { message: 'selectionInstruction required on group notification.' };

        mockEvent.audienceType = 'GROUP';
        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing templates', async () => {
        const expectedResult = { message: 'Templates cannot be null.' };

        mockEvent.defaultTemplate = null;
        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing templates:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing required property value', async () => {
        const expectedResult = { message: 'Missing required property value: presentationType' };

        mockEvent.presentationType = null;
        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required property value:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });
});

describe('*** UNIT TESTING MESSAGE INSTRUCTION DEACTIVATION ***', () => {

    const mockInstructionId = uuid();
    const mockInstructionIdOnError = uuid();
    const mockInsertionId = 111;
    const mockUpdateTime = '2049-06-22T07:38:30.016Z';

    const mockUpdateRecordArgs = (instructionId) => [
        `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning insertion_id, update_time`,
        ['active', false, instructionId]
    ];

    beforeEach(() => {
        resetStubs();
    });

    it('should deactivate message instruction', async () => {
        updateRecordStub.withArgs(...mockUpdateRecordArgs(mockInstructionId)).returns({ rows: [ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ] });

        const mockEvent = {
            instructionId: mockInstructionId
        };

        const expectedResult = { message: [ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ] };

        const result = await handler.deactivateMessageInstruction(mockEvent);
        logger('Result of message instruction deactivation:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateRecordArgs(mockInstructionId));
    });

    it('should throw an error on persistence operations failure', async () => {
        updateRecordStub.withArgs(...mockUpdateRecordArgs(mockInstructionIdOnError)).throws( new Error('A persistence derived error.' ));

        const mockEvent = {
            instructionId: mockInstructionIdOnError
        };

        const expectedResult = { message: 'A persistence derived error.' };

        const result = await handler.deactivateMessageInstruction(mockEvent);
        logger('Result of message instruction deactivation on persistence error:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateRecordArgs(mockInstructionIdOnError));
    });
});

describe('*** UNIT TESTING MESSAGE INSTRUCTION EXTRACTION ***', () => {

    const mockInstructionId = uuid();
    const mockInstructionIdOnError = uuid();
    const boostId = uuid();

    const mockPersistedInstuction = (instructionId) => [{
        instructionId: instructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: { 
            default: config.get('templates.default'),
            otherTemplates: null
        },
        selectionInstruction: null,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: boostId },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        priority: 0
    }];

    const mockSelectQueryArgs = (instructionId) => [
       `select * from ${config.get('tables.messageInstructionTable')} where instruction_id = $1`,
       [instructionId]
    ];

    beforeEach(() => {
        resetStubs();
    });

    it('should read message instruction from database', async () => {
        selectQueryStub.withArgs(...mockSelectQueryArgs(mockInstructionId)).returns(mockPersistedInstuction(mockInstructionId));

        const expectedResult = { message: mockPersistedInstuction(mockInstructionId)[0] };

        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.getMessageInstruction(mockEvent);
        logger('Result of message instruction extraction:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(mockInstructionId));
    });

    it('should throw an error on persistence error (or general error)', async () => {
        selectQueryStub.withArgs(...mockSelectQueryArgs(mockInstructionIdOnError)).throws( new Error('A persistence derived error.' ));

        const expectedResult = { message: 'A persistence derived error.' };

        const mockEvent = {
            instructionId: mockInstructionIdOnError
        };

        const result = await handler.getMessageInstruction(mockEvent);
        logger('Result of message instruction extraction:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(mockInstructionIdOnError));
    });
});
