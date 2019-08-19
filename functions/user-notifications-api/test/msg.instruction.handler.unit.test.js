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
const momentStub = sinon.stub();
const uuidStub = sinon.stub();

const handler = proxyquire('../msg-instruction-handler', {
    './persistence/rds.notifications': {
        'insertMessageInstruction': insertMessageInstructionStub,
        'getMessageInstruction': getMessageInstructionStub,
        'updateMessageInstruction': updateMessageInstructionStub
    },
    'uuid/v4': uuidStub,
    'moment': momentStub,
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
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockInsertionId = 111;
    const mockClientId = uuid();
    const testTime = moment();

    const mockEvent = {
        presentationType: 'ONCE_OFF',
        audienceType: 'ALL_USERS',
        defaultTemplate: config.get('instruction.templates.default'),
        otherTemplates: null,
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: uuid() },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        messagePriority: 0
    };

    const resetEvent = () => {
        mockEvent.presentationType = 'ONCE_OFF';
        mockEvent.audienceType = 'ALL_USERS';
        mockEvent.defaultTemplate = config.get('instruction.templates.default');
        mockEvent.selectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`
    };

    const mockPersistableObject = (mockInstruction) => ({
        instructionId: mockInstructionId,
        presentationType: mockInstruction.presentationType,
        active: true,
        audienceType: mockInstruction.audienceType,
        templates: JSON.stringify({
            default: mockInstruction.defaultTemplate,
            otherTemplates: mockInstruction.otherTemplates ? mockInstruction.otherTemplates : null
        }),
        selectionInstruction: mockInstruction.selectionInstruction ? mockInstruction.selectionInstruction : null,
        recurrenceInstruction: mockInstruction.recurrenceInstruction ? JSON.stringify(mockInstruction.recurrenceInstruction) : null,
        responseAction: mockInstruction.responseAction ? mockInstruction.responseAction : null,
        responseContext: mockInstruction.responseContext ? JSON.stringify(mockInstruction.responseContext) : null,
        startTime: mockInstruction.startTime ? mockInstruction.startTime : moment().format(),
        endTime: mockInstruction.endTime ? mockInstruction.endTime : moment().add(500, 'years').format(),
        lastProcessedTime: testTime.format(),
        messagePriority: mockInstruction.messagePriority ? mockInstruction.messagePriority : 0
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
        momentStub.returns({ format: () => testTime.format() });
    });

    it('should insert new message intruction', async () => {
        insertMessageInstructionStub.withArgs(mockPersistableObject(mockEvent)).returns([ { instruction_id: mockInstructionId, insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = { message: [ { instruction_id: mockInstructionId, insertion_id: mockInsertionId, creation_time: mockCreationTime } ] };
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
        mockEvent.selectionInstruction = null;
        const expectedResult = { message: 'selectionInstruction required on indivdual notification.' };
        mockEvent.audienceType = 'INDIVIDUAL';

        const result = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on group notification', async () => {
        mockEvent.selectionInstruction = null;
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
    const mockClientId = uuid();
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
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: boostId },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        messagePriority: 0
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
