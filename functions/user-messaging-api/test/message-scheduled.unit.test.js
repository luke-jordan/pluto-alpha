'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testHelper = require('./message.test.helper');

const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const getInstructionsByTypeStub = sinon.stub();
const updateInstructionStateStub = sinon.stub();
const updateProcessedTimeStub = sinon.stub();
const filterUserIdsForRecurrenceStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();
const publishMultiLogStub = sinon.stub();

const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../message-creating-handler', {
    './persistence/rds.usermessages': {
        'getUserIdsForAudience': getUserIdsStub,
        'insertUserMessages': insertUserMessagesStub,
        'getInstructionsByType': getInstructionsByTypeStub,
        'filterUserIdsForRecurrence': filterUserIdsForRecurrenceStub,
        'updateInstructionState': updateInstructionStateStub,
        'updateInstructionProcessedTime': updateProcessedTimeStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiLogStub,
        '@noCallThru': true
    },
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient
    }
});

const createMockUserIds = (quantity) => Array(quantity).fill().map(() => uuid());

const mockAudienceId = uuid();

const recurringMsgTemplate = require('./templates/recurringTemplate');
const simpleCardMsgTemplate = require('./templates/simpleTemplate');

const argsForRefreshAudienceLambda = {
    FunctionName: 'audience_selection',
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ operation: 'refresh', params: { audienceId: mockAudienceId } })
};

const testRefreshAudienceResponse = {
    result: `Refreshed audience id: ${mockAudienceId} successfully`
};

const resetStubs = () => testHelper.resetStubs(getInstructionsByTypeStub, filterUserIdsForRecurrenceStub,
    getUserIdsStub, insertUserMessagesStub, updateInstructionStateStub, updateProcessedTimeStub, lambdaInvokeStub, momentStub);

describe('*** UNIT TESTING PENDING INSTRUCTIONS HANDLER ***', () => {

    const mockInstructionId = uuid();

    const testTime = moment();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockUpdatedTime = '2049-06-22T08:00:21.016Z';

    const expectedInsertionRows = (quantity, start = 1) => Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: { template: { DEFAULT: recurringMsgTemplate }},
        audienceId: mockAudienceId,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 0
    };

    beforeEach(() => {
        resetStubs();
        momentStub.returns(testTime.clone());
    });

    it('Sends pending instructions', async () => {
        getInstructionsByTypeStub.resolves([mockInstruction, mockInstruction]);
        filterUserIdsForRecurrenceStub.resolves(createMockUserIds(10));
        getUserIdsStub.resolves(createMockUserIds(10));
        insertUserMessagesStub.resolves(expectedInsertionRows(10));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        updateProcessedTimeStub.withArgs(mockInstructionId, testTime.format()).resolves({ updatedTime: mockUpdatedTime });
        lambdaInvokeStub.withArgs(argsForRefreshAudienceLambda).returns({ promise: () => testHelper.mockLambdaResponse(testRefreshAudienceResponse) });

        const result = await handler.createFromPendingInstructions();
        logger('Result of pending instruction handling:', result);

        expect(result).to.exist;
        expect(result).to.have.property('messagesProcessed', 2);
        expect(result).to.have.property('processResults');
        result.processResults.forEach((processResult) => {
            const standardizedResult = Array.isArray(processResult) ? processResult[0] : processResult;
            expect(standardizedResult).to.have.property('instructionId', mockInstructionId);
            expect(standardizedResult).to.have.property('instructionType', 'RECURRING');
            expect(standardizedResult).to.have.property('numberMessagesCreated', 10);
            expect(standardizedResult).to.have.property('creationTimeMillis', mockCreationTime);
            expect(standardizedResult).to.have.property('instructionUpdateTime', mockUpdatedTime);
        });
        expect(getInstructionsByTypeStub).to.have.been.calledWith('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(getInstructionsByTypeStub).to.have.been.calledWith('RECURRING');
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(argsForRefreshAudienceLambda);
        expect(lambdaInvokeStub).to.have.been.callCount(2);
        expect(filterUserIdsForRecurrenceStub).to.have.been.calledTwice;
        expect(getUserIdsStub).to.have.been.called;
        expect(insertUserMessagesStub).to.have.been.called;
        expect(updateInstructionStateStub).to.have.been.called;
        expect(updateProcessedTimeStub).to.have.been.called;
    });

    it('Handles empty recurring messages', async () => {
        getInstructionsByTypeStub.resolves([mockInstruction, mockInstruction]);
        getUserIdsStub.resolves([]);
    
        const result = await handler.createFromPendingInstructions();
        logger('Result of pending instruction handling:', result);
    });

    // redundant
    // it('Fails on invalid template', async () => {
    //     const mockBadInstruction = {
    //         instructionId: mockInstructionId,
    //         audienceId: mockAudienceId,
    //         templates: '{ template: { DEFAULT: recurringMsgTemplate }}'
    //     };

    //     lambdaInvokeStub.withArgs(argsForRefreshAudienceLambda).returns({ promise: () => testHelper.mockLambdaResponse(testRefreshAudienceResponse) });

    //     getInstructionsByTypeStub.resolves([mockInstruction, mockBadInstruction]);
    //     filterUserIdsForRecurrenceStub.resolves(createMockUserIds(10));
    //     getUserIdsStub.resolves(createMockUserIds(10));

    //     const result = await handler.createFromPendingInstructions();
    //     logger('Result on malformed template:', result);

    //     expect(result).to.exist;
    //     expect(result).to.deep.equal({ result: 'ERROR', message: 'Malformed template instruction: ' });
    //     expect(getInstructionsByTypeStub).to.have.been.calledWith('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
    //     expect(filterUserIdsForRecurrenceStub).to.have.been.calledTwice;
    //     expect(getUserIdsStub).to.have.been.calledWith(mockAudienceId);
    //     expect(lambdaInvokeStub).to.have.been.calledWithExactly(argsForRefreshAudienceLambda);
    //     expect(lambdaInvokeStub).to.have.been.callCount(2);
    //     expect(insertUserMessagesStub).to.have.been.calledOnce; // i.e., with the good instruction
    //     expect(updateInstructionStateStub).to.have.not.been.called;
    //     expect(updateMessageInstructionStub).to.have.not.been.called;
    // });

    it('Catches thrown errors', async () => {
        getInstructionsByTypeStub.rejects(new Error('ProcessError'));
        
        const result = await handler.createFromPendingInstructions();
        logger('Result on error:', result);

        expect(result).to.exist;
        expect(result).to.have.property('result', 'ERROR');
        expect(result).to.have.property('message', 'ProcessError');
        expect(getInstructionsByTypeStub).to.have.been.calledOnceWithExactly('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(filterUserIdsForRecurrenceStub).to.have.not.been.called;
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;
        expect(updateProcessedTimeStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST MESSAGE SCHEDULING ***', () => {
    const mockInstructionId = uuid();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockUpdatedTime = '2049-06-22T08:00:21.016Z';

    const testTime = moment();

    const expectedInsertionRows = (quantity, start = 1) => Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    beforeEach(() => {
        resetStubs();
        momentStub.returns(testTime.clone());
    });

    it('Sends scheduled once off messages', async () => {
        const testScheduledMsgInstruction = {
            instructionId: mockInstructionId,
            presentationType: 'ONCE_OFF',
            active: true,
            audienceType: 'ALL_USERS',
            templates: { template: { DEFAULT: simpleCardMsgTemplate }},
            audienceId: mockAudienceId,
            recurrenceInstruction: null,
            responseAction: 'VIEW_HISTORY',
            responseContext: null,
            startTime: moment().format(),
            endTime: moment().add('1', 'day').format(),
            lastProcessedTime: moment().format(),
            messagePriority: 0
        };

        lambdaInvokeStub.withArgs(argsForRefreshAudienceLambda).returns({ promise: () => testHelper.mockLambdaResponse(testRefreshAudienceResponse) });
        getInstructionsByTypeStub.resolves([testScheduledMsgInstruction, testScheduledMsgInstruction]);
        filterUserIdsForRecurrenceStub.resolves(createMockUserIds(10));
        getUserIdsStub.resolves(createMockUserIds(10));
        insertUserMessagesStub.resolves(expectedInsertionRows(10));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        updateProcessedTimeStub.withArgs(mockInstructionId, testTime.format()).resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createFromPendingInstructions();
        logger('Result of scheduled message handling:', JSON.stringify(result));

        expect(result).to.exist;
        expect(result).to.have.property('messagesProcessed', 2);
        expect(result).to.have.property('processResults');

        result.processResults.forEach((processResult) => {
            const standardizedResult = Array.isArray(processResult) ? processResult[0] : processResult;
            expect(standardizedResult).to.have.property('instructionId', mockInstructionId);
            expect(standardizedResult).to.have.property('instructionType', 'ONCE_OFF');
            expect(standardizedResult).to.have.property('numberMessagesCreated', 10);
            expect(standardizedResult).to.have.property('creationTimeMillis', mockCreationTime);
            expect(standardizedResult).to.have.property('instructionUpdateTime', mockUpdatedTime);
        });

        expect(getInstructionsByTypeStub).to.have.been.calledWith('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(getInstructionsByTypeStub).to.have.been.calledWith('RECURRING');
        expect(filterUserIdsForRecurrenceStub).to.have.been.calledTwice;
        expect(getUserIdsStub).to.have.been.called;

        expect(lambdaInvokeStub).to.have.been.callCount(2);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(argsForRefreshAudienceLambda);

        expect(insertUserMessagesStub).to.have.been.called;
        expect(updateInstructionStateStub).to.have.been.called;
    });

    it('Skips scheduled once off messages if start time is in the future', async () => {
        const testScheduledMsgInstruction = {
            instructionId: mockInstructionId,
            presentationType: 'ONCE_OFF',
            active: true,
            audienceType: 'ALL_USERS',
            templates: { template: { DEFAULT: simpleCardMsgTemplate }},
            audienceId: mockAudienceId,
            recurrenceInstruction: null,
            responseAction: 'VIEW_HISTORY',
            responseContext: null,
            startTime: moment().add(1, 'week').format(),
            endTime: moment().add('1', 'day').format(),
            lastProcessedTime: moment().format(),
            messagePriority: 0
        };

        lambdaInvokeStub.withArgs(argsForRefreshAudienceLambda).returns({ promise: () => testHelper.mockLambdaResponse(testRefreshAudienceResponse) });

        getInstructionsByTypeStub.resolves([testScheduledMsgInstruction, testScheduledMsgInstruction]);
        filterUserIdsForRecurrenceStub.resolves(createMockUserIds(10));
        getUserIdsStub.resolves(createMockUserIds(10));
        insertUserMessagesStub.resolves(expectedInsertionRows(10));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });        
        updateProcessedTimeStub.withArgs(mockInstructionId, testTime.format()).resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createFromPendingInstructions();
        logger('Result of scheduled message handling:', JSON.stringify(result));

        expect(lambdaInvokeStub).to.have.been.calledWithExactly(argsForRefreshAudienceLambda);
        expect(lambdaInvokeStub).to.have.been.callCount(2);
        expect(result).to.exist;
        expect(result).to.have.property('messagesProcessed', 2);
        expect(result).to.have.property('processResults');
        result.processResults.forEach((processResult) => {
            const standardizedResult = Array.isArray(processResult) ? processResult[0] : processResult;
            expect(standardizedResult).to.have.property('instructionId', mockInstructionId);
            if (Object.keys(standardizedResult).length > 2) {
                expect(standardizedResult).to.have.property('instructionType', 'ONCE_OFF');
                expect(standardizedResult).to.have.property('numberMessagesCreated', 10);
                expect(standardizedResult).to.have.property('creationTimeMillis', mockCreationTime);
                expect(standardizedResult).to.have.property('instructionUpdateTime', mockUpdatedTime);
            } else {
                expect(standardizedResult).to.have.property('processResult', 'INSTRUCTION_SCHEDULED');
            }
        });
        expect(getInstructionsByTypeStub).to.have.been.calledWith('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(getInstructionsByTypeStub).to.have.been.calledWith('RECURRING');
        expect(filterUserIdsForRecurrenceStub).to.have.been.calledTwice;
        expect(getUserIdsStub).to.have.been.called;
        expect(insertUserMessagesStub).to.have.been.called;
        expect(updateInstructionStateStub).to.have.been.called;
    });
});
