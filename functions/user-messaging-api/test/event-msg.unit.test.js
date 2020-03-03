'use strict';

// const logger = require('debug')('jupiter:message-creating:test');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testHelper = require('./message.test.helper');

const getMessageInstructionStub = sinon.stub();
const findMsgInstructionByFlagStub = sinon.stub();
const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const updateInstructionStateStub = sinon.stub();

const publishMultiLogStub = sinon.stub();

const momentStub = sinon.stub();

const handler = proxyquire('../message-creating-handler', {
    './persistence/rds.notifications': {
        'findMsgInstructionByFlag': findMsgInstructionByFlagStub,
        'updateInstructionState': updateInstructionStateStub,
        'getMessageInstruction': getMessageInstructionStub,
        'insertUserMessages': insertUserMessagesStub,
        'getUserIds': getUserIdsStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiLogStub,
        '@noCallThru': true
    },
    'moment': momentStub
});

const resetStubs = () => testHelper.resetStubs(getMessageInstructionStub, getUserIdsStub, insertUserMessagesStub, momentStub, updateInstructionStateStub, findMsgInstructionByFlagStub);

describe('*** UNIT TEST EVENT TRIGGERED MESSAGES ***', () => {
    const mockUserId = uuid();
    const mockAudienceId = uuid();
    const mockInstructionId = uuid();

    const testTime = moment();
    const mockCreationTime = moment().format();
    const mockUpdatedTime = moment().format();

    const mockTemplate = {
        template: {
            DEFAULT: {
                title: 'Saving Event Successful',
                body: 'You have successfully taken a step towards a better future. Keep it up.',
                display: { type: 'EMAIL' }
            }
        }
    };

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'EVENT_DRIVEN',
        active: true,
        audienceType: 'ALL_USERS',
        templates: mockTemplate,
        audienceId: mockAudienceId,
        recurrenceInstruction: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 100
    };


    const expectedInsertionRows = (quantity, start = 1) => Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    const wrapEventSns = (event) => ({
        Records: [{ Sns: { Message: JSON.stringify(event) }}]
    });

    beforeEach(() => {
        resetStubs();
        momentStub.returns(testTime);
    });

    it('Sends user messages when triggered by non-blacklisted events', async () => {

        publishMultiLogStub.resolves({ result: 'SUCCESS' });
        findMsgInstructionByFlagStub.resolves([mockInstructionId, mockInstructionId]);
        getMessageInstructionStub.resolves(mockInstruction);
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.resolves({ updatedTime: mockUpdatedTime });

        const mockEvent = wrapEventSns({ instructionId: mockInstructionId, userId: mockUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL' });

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 200 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');
        expect(getMessageInstructionStub).to.have.been.calledTwice;
        expect(getMessageInstructionStub).to.have.been.calledWith(mockInstructionId);
        expect(insertUserMessagesStub).to.have.been.calledTwice;
        expect(updateInstructionStateStub).to.have.been.calledTwice;
        expect(updateInstructionStateStub).to.have.been.calledWith(mockInstructionId, 'MESSAGES_GENERATED');

        let insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(1);

        insertUserMsgArgs = insertUserMessagesStub.getCall(1).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(1);

    });

    it('Returns 403 when called by blacklisted event', async () => {

        const mockEvent = wrapEventSns({ instructionId: mockInstructionId, userId: mockUserId, eventType: 'MESSAGE_PUSH_NOTIFICATION_SENT' });

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 403 });

        expect(findMsgInstructionByFlagStub).to.have.not.been.called;
        expect(getMessageInstructionStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;

    });

    it('Catched thrown errors', async () => {

        findMsgInstructionByFlagStub.throws(new Error('Error'));
    
        const mockEvent = wrapEventSns({ instructionId: mockInstructionId, userId: mockUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL' });

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 500 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');
        expect(getMessageInstructionStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;

    });
});
