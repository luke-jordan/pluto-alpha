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

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
    }
}

const handler = proxyquire('../create-msg-instruction', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});


const resetStubs = () => {
    insertRecordsStub.reset();
};

describe('*** UNIT TESTING MESSAGE INSTRUCTION INSERTION ***', () => {

    const mockEvent = {
        presentationType: 'ONCE_OFF',
        audienceType: 'ALL_USERS',
        defaultTemplate: { default: 'tbd' },
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
        mockEvent.defaultTemplate = { default: 'tbd' };
    };

    const insertionQueryArray = [
        'presentation_type',
        'active',
        'audience_type',
        'templates',
        'selection_instruction',
        'recurrence_instruction',
        'response_action',
        'start_time',
        'end_time',
        'priority'
    ]

    const mockInsertRecordsArgs = [
        `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`,
        '${presentationType} ${active} ${audienceType} ${templates} ${selectionInstruction} ${recurrenceInstruction} ${responseAction} ${responseContext} ${startTime} ${endTime} ${priority}',
        [{
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
        insertRecordsStub.
            withArgs(...mockInsertRecordsArgs).
            returns({ rows: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] });
    });

    it('should insert new message intruction', async () => {
        const expectedResult = [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ];

        const result = await handler.createMsgInstructions(mockEvent);
        logger('Result of message instruction creation:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertRecordsArgs);
    });

    it('it should throw an error on missing recurrance instruction where presentation type is RECURRING', async () => {
        const expectedResult = { error: 'recurrenceInstruction is required where presentationType is set to RECURRING.' };

        mockEvent.presentationType = 'RECURRING';
        const result = await handler.createMsgInstructions(mockEvent);
        logger('Result of message instruction insertion on missing required recurrance instruction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on individual notification', async () => {
        const expectedResult = { error: 'selectionInstruction required on indivdual notification.' };

        mockEvent.audienceType = 'INDIVIDUAL';
        const result = await handler.createMsgInstructions(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on group notification', async () => {
        const expectedResult = { error: 'selectionInstruction required on group notification.' };

        mockEvent.audienceType = 'GROUP';
        const result = await handler.createMsgInstructions(mockEvent);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing templates', async () => {
        const expectedResult = { error: 'Templates cannot be null.' };

        mockEvent.defaultTemplate = null;
        const result = await handler.createMsgInstructions(mockEvent);
        logger('Result of message instruction insertion on missing templates:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });

    it('should throw an error on missing required property value', async () => {
        const expectedResult = { error: 'Missing required property value: presentationType' };

        mockEvent.presentationType = null;
        const result = await handler.createMsgInstructions(mockEvent);
        logger('Result of message instruction insertion on missing required property value:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.not.been.called;
    });
});
