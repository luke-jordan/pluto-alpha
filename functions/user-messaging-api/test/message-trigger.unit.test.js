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

const fetchMsgInstructionStub = sinon.stub();
const findMsgInstructionByFlagStub = sinon.stub();
const findMsgToHaltStub = sinon.stub();
const findMsgIdsStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();
const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const mockUserId = uuid();

const handler = proxyquire('../message-trigger-handler', {
    './persistence/rds.instructions': {
        'getMessageInstruction': fetchMsgInstructionStub,
        'findMsgInstructionTriggeredByEvent': findMsgInstructionByFlagStub,
        'findMsgInstructionHaltedByEvent': findMsgToHaltStub,
        'getMessageIdsForInstructions': findMsgIdsStub, 
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    },
    'moment': momentStub
});

const wrapEventSns = (event) => ({
    Records: [{ Sns: { Message: JSON.stringify(event) }}]
});

const resetStubs = () => testHelper.resetStubs(fetchMsgInstructionStub, findMsgInstructionByFlagStub, findMsgToHaltStub, lambdaInvokeStub);

describe('*** UNIT TEST SIMPLE EVENT TRIGGERED MESSAGES ***', () => {

    const mockAudienceId = uuid();
    const mockInstructionId = uuid();

    const testTime = moment();

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

    beforeEach(() => {
        resetStubs();
        momentStub.returns(testTime);
    });

    it('Sends user messages when triggered by non-blacklisted events', async () => {
        findMsgInstructionByFlagStub.resolves([mockInstruction]);
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});

        const mockEvent = wrapEventSns({ userId: mockUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL' });

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 200 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');
        
        const expectedPaylod = { instructions: [{ instructionId: mockInstructionId, destinationUserId: mockUserId }] };
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(testHelper.wrapLambdaInvoc('message_user_create_once', true, expectedPaylod));
    });

    it('Returns 200 when called by blacklisted event', async () => {
        const mockEvent = wrapEventSns({ userId: mockUserId, eventType: 'MESSAGE_PUSH_NOTIFICATION_SENT' });

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 200 });

        expect(findMsgInstructionByFlagStub).to.have.not.been.called;
        expect(findMsgToHaltStub).to.have.not.been.called;
        expect(lambdaInvokeStub).to.have.not.been.called;
    });

    it('Catches thrown errors, but they do not interfere (halt still called)', async () => {
        findMsgInstructionByFlagStub.throws(new Error('Error'));
    
        const mockEvent = wrapEventSns({ instructionId: mockInstructionId, userId: mockUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL' });

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 500 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');
        expect(findMsgToHaltStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');
        expect(lambdaInvokeStub).to.have.not.been.called;
    });
});

describe('*** UNIT TEST SCHEDULE-TRIGGERED MESSAGES ***', () => {

    const mockInstructionId = uuid();

    beforeEach(() => testHelper.resetStubs(findMsgInstructionByFlagStub, findMsgToHaltStub, fetchMsgInstructionStub, lambdaInvokeStub, momentStub));

    it('Creates message based on triggering event, for time in future, hours and minutes', async () => {
        const mockEvent = wrapEventSns({ userId: mockUserId, eventType: 'MANUAL_EFT_INITIATED' });

        const mockMoment = moment();
        const expectedMoment = mockMoment.clone().add(24, 'hours');

        const mockInstruction = {
            instructionId: mockInstructionId,
            triggerParameters: {
                triggerEvent: ['MANUAL_EFT_INITIATED'],
                haltingEvent: ['SAVING_PAYMENT_SUCCESSFUL'],
                messageSchedule: {
                    type: 'RELATIVE',
                    offset: { unit: 'hours', number: 24 }
                }
            }
        };

        findMsgInstructionByFlagStub.resolves([mockInstruction]);
        findMsgToHaltStub.resolves([]);
        momentStub.returns(mockMoment.clone());
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.deep.equal({ statusCode: 200 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('MANUAL_EFT_INITIATED');
        expect(findMsgToHaltStub).to.have.been.calledOnceWithExactly('MANUAL_EFT_INITIATED');
        
        const expectedPaylod = { 
            instructions: 
                [{
                    instructionId: mockInstructionId,
                    destinationUserId: mockUserId,
                    scheduledTimeEpochMillis: expectedMoment.valueOf()
                }]
        };

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(testHelper.wrapLambdaInvoc('message_user_create_once', true, expectedPaylod));
    });

    it('Creates message based on triggering event, for set time the next day', async () => {
        const mockEvent = wrapEventSns({ userId: mockUserId, eventType: 'MANUAL_EFT_INITIATED' });

        const mockMoment = moment();
        const expectedMoment = mockMoment.clone().add(1, 'day').set({ hour: 16, minute: 0 });

        const mockInstruction = {
            instructionId: mockInstructionId,
            triggerParameters: {
                triggerEvent: ['MANUAL_EFT_INITIATED'],
                haltingEvent: ['SAVING_PAYMENT_SUCCESSFUL'],
                messageSchedule: {
                    type: 'FIXED',
                    offset: { unit: 'day', number: 1 },
                    fixed: { hour: 16, minute: 0 }
                }
            }
        };

        findMsgInstructionByFlagStub.resolves([mockInstruction]);
        findMsgToHaltStub.resolves([]);
        momentStub.returns(mockMoment.clone());
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.deep.equal({ statusCode: 200 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('MANUAL_EFT_INITIATED');
        expect(findMsgToHaltStub).to.have.been.calledOnceWithExactly('MANUAL_EFT_INITIATED');
        
        const expectedPaylod = { 
            instructions: 
                [{
                    instructionId: mockInstructionId,
                    destinationUserId: mockUserId,
                    scheduledTimeEpochMillis: expectedMoment.valueOf()
                }]
        };

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(testHelper.wrapLambdaInvoc('message_user_create_once', true, expectedPaylod));
    });

    // todo : disable the instruction automatically if this happens
    it('Throws an error if invalid trigger event', async () => {
        const mockEvent = wrapEventSns({ userId: mockUserId, eventType: 'MANUAL_EFT_INITIATED' });

        const mockInstruction = {
            instructionId: mockInstructionId,
            triggerParameters: {
                triggerEvent: ['MANUAL_EFT_INITIATED'],
                haltingEvent: ['SAVING_PAYMENT_SUCCESSFUL'],
                messageSchedule: {
                    type: 'IRREGULAR',
                    offset: { unit: 'day', number: 1 },
                    fixed: { hour: 16, minute: 0 }
                }
            }
        };

        findMsgInstructionByFlagStub.resolves([mockInstruction]);
        findMsgToHaltStub.resolves([]);

        const result = await handler.createFromUserEvent(mockEvent);
        expect(result).to.deep.equal({ statusCode: 500 });

        expect(lambdaInvokeStub).to.not.have.been.called;
    });

});

describe('*** UNIT TEST CANCEL TRIGGERED MESSAGES ON HALT EVENT ***', () => {

    beforeEach(() => testHelper.resetStubs(findMsgInstructionByFlagStub, findMsgToHaltStub, fetchMsgInstructionStub, lambdaInvokeStub, momentStub));

    it('Cancels messages (multiple) when halting event arrives', async () => {
        const mockEvent = wrapEventSns({ userId: mockUserId, eventType: 'SAVING_PAYMENT_SUCCESSFUL' });

        findMsgInstructionByFlagStub.resolves([]);
        findMsgToHaltStub.resolves(['instruction1', 'instruction2']);
        findMsgIdsStub.resolves(['message1', 'message2']);

        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});

        const result = await handler.createFromUserEvent(mockEvent);

        expect(result).to.deep.equal({ statusCode: 200 });

        expect(findMsgInstructionByFlagStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');
        expect(findMsgToHaltStub).to.have.been.calledOnceWithExactly('SAVING_PAYMENT_SUCCESSFUL');

        const soughtStatuses = ['CREATED', 'SCHEDULED', 'READY_FOR_SENDING', 'SENDING'];
        expect(findMsgIdsStub).to.have.been.calledOnceWithExactly(['instruction1', 'instruction2'], mockUserId, soughtStatuses);

        const expectedInvoke = (messageId) => testHelper.wrapLambdaInvoc('message_user_process', true, { messageId, newStatus: 'SUPERCEDED' });
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedInvoke('message1'));
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedInvoke('message2'));
    });

});
