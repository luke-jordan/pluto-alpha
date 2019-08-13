'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instruction-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');

const insertMessageInstructionStub = sinon.stub();
const updateMessageInstructionStub = sinon.stub();
const getMessageInstructionStub = sinon.stub();
const uuidStub = sinon.stub();

const handler = proxyquire('../msg-instruction-handler', {
    './persistence/rds.notifications': {
        'insertMessageInstruction': insertMessageInstructionStub,
        'getMessageInstruction': getMessageInstructionStub,
        'updateMessageInstruction': updateMessageInstructionStub
    },
    'uuid/v4': uuidStub, 
    '@noCallThru': true
});


const resetStubs = () => {
    insertMessageInstructionStub.reset();
    updateMessageInstructionStub.reset();
    getMessageInstructionStub.reset();
    uuidStub.reset();
};

describe('*** UNIT TESTING MESSAGE INSTRUCTION INSERTION ***', () => {
    
    const mockInstructionId = uuid();

    const mockEvent = {
        presentationType: 'ONCE_OFF',
        audienceType: 'ALL_USERS',
        defaultTemplate: config.get('instruction.templates.default'),
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
        mockEvent.defaultTemplate = config.get('instruction.templates.default');
    };

    const mockPersistableObject = (mockEvent) => ({
        instructionId: mockInstructionId,
        presentationType: mockEvent.presentationType,
        active: true,
        audienceType: mockEvent.audienceType,
        templates: {
            default: mockEvent.defaultTemplate,
            otherTemplates: mockEvent.otherTemplates? mockEvent.otherTemplates: null
        },
        selectionInstruction: mockEvent.selectionInstruction? mockEvent.selectionInstruction: null,
        recurrenceInstruction: mockEvent.recurrenceInstruction? mockEvent.recurrenceInstruction: null,
        responseAction: mockEvent.responseAction? mockEvent.responseAction: null,
        responseContext: mockEvent.responseContext? mockEvent.responseContext: null,
        startTime: mockEvent.startTime? mockEvent.startTime: moment().format(),
        endTime: mockEvent.endTime? mockEvent.endTime: moment().add(500, 'years').format(),
        priority: mockEvent.priority? mockEvent.priority: 0
    });

    const commonAssertions = (result, statusCode, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
        resetEvent();
        uuidStub.returns(mockInstructionId);
    });

    it('should insert new message intruction', async () => {
        insertMessageInstructionStub.withArgs(mockPersistableObject(mockEvent)).returns([ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ]);
        const expectedResult = { message: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] };
        const result = await handler.insertMessageInstruction(mockEvent);

        logger('Result of message instruction creation:', result);
        logger('mockInstructionId:', mockInstructionId);

        commonAssertions(result, 200, expectedResult);
        expect(insertMessageInstructionStub).to.have.been.calledOnceWithExactly(mockPersistableObject(mockEvent));
    });

    it('it should throw an error on missing recurrance instruction where presentation type is RECURRING', async () => {
        const expectedResult = { message: 'recurrenceInstruction is required where presentationType is set to RECURRING.' };
        mockEvent.presentationType = 'RECURRING';

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required recurrance instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on individual notification', async () => {
        const expectedResult = { message: 'selectionInstruction required on indivdual notification.' };
        mockEvent.audienceType = 'INDIVIDUAL';

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on group notification', async () => {
        const expectedResult = { message: 'selectionInstruction required on group notification.' };
        mockEvent.audienceType = 'GROUP';

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing templates', async () => {
        const expectedResult = { message: 'Templates cannot be null.' };
        mockEvent.defaultTemplate = null;

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing templates:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing required property value', async () => {
        const expectedResult = { message: 'Missing required property value: presentationType' };
        mockEvent.presentationType = null;

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required property value:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });
});

describe('*** UNIT TESTING MESSAGE INSTRUCTION DEACTIVATION ***', () => {

    const mockInstructionId = uuid();
    const mockInstructionIdOnError = uuid();
    const mockInsertionId = 111;
    const mockUpdateTime = '2049-06-22T07:38:30.016Z';

    const commonAssertions = (result, statusCode, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
    });

    it('should deactivate message instruction', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, 'active', false).returns([ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ]);
        const mockEvent = {
            instructionId: mockInstructionId
        };
        const expectedResult = { message: [ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ] };

        const result = await handler.deactivateMessageInstruction(mockEvent);
        logger('Result of message instruction deactivation:', result);

        commonAssertions(result, 200, expectedResult);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'active', false);
    });

    it('should return an error on failure', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionIdOnError, 'active', false).throws( new Error('A persistence derived error.' ));
        const mockEvent = {
            instructionId: mockInstructionIdOnError
        };
        const expectedResult = { message: 'A persistence derived error.' };

        const result = await handler.deactivateMessageInstruction(mockEvent);
        logger('Result of message instruction deactivation on persistence error:', result);

        commonAssertions(result, 500, expectedResult);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnError, 'active', false);
    });
});

describe('*** UNIT TESTING MESSAGE INSTRUCTION EXTRACTION ***', () => {

    const mockInstructionId = uuid();
    const mockInstructionIdOnError = uuid();
    const boostId = uuid();

    const mockPersistedInstuction = (instructionId) => ({
        instructionId: instructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: { 
            default: config.get('instruction.templates.default'),
            otherTemplates: null
        },
        selectionInstruction: null,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: boostId },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        priority: 0
    });

    const commonAssertions = (result, statusCode, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
    });

    it('should read message instruction from database', async () => {
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockPersistedInstuction(mockInstructionId));
        const expectedResult = { message: mockPersistedInstuction(mockInstructionId) };
        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.getMessageInstruction(mockEvent);
        logger('Result of message instruction extraction:', result);

        commonAssertions(result, 200, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
    });

    it('should throw an error on persistence error (or general error)', async () => {
        getMessageInstructionStub.withArgs(mockInstructionIdOnError).throws( new Error('A persistence derived error.' ));
        const expectedResult = { message: 'A persistence derived error.' };
        const mockEvent = {
            instructionId: mockInstructionIdOnError
        };

        const result = await handler.getMessageInstruction(mockEvent);
        logger('Result of message instruction extraction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnError);
    });
});
