'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instruction-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testRecurringTemplate = require('./templates/recurringTemplate');
const testHelper = require('./message.test.helper');

const insertMessageInstructionStub = sinon.stub();
const updateMessageInstructionStub = sinon.stub();
const getMessageInstructionStub = sinon.stub();
const getCurrentInstructionsStub = sinon.stub();
const alterInstructionStatesStub = sinon.stub();
const momentStub = sinon.stub();
const uuidStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../msg-instruction-handler', {
    './persistence/rds.notifications': {
        'insertMessageInstruction': insertMessageInstructionStub,
        'getMessageInstruction': getMessageInstructionStub,
        'updateMessageInstruction': updateMessageInstructionStub,
        'getCurrentInstructions': getCurrentInstructionsStub,
        'alterInstructionMessageStates': alterInstructionStatesStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'uuid/v4': uuidStub,
    'moment': momentStub,
    '@noCallThru': true
});


describe('*** UNIT TESTING MESSAGE INSTRUCTION INSERTION ***', () => {
    
    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockAudienceId = uuid();
    const testTime = moment();

    const mockInstruction = {
        creatingUserId: mockUserId,
        presentationType: 'ONCE_OFF',
        audienceType: 'ALL_USERS',
        templates: { template: { 'DEFAULT': testRecurringTemplate }},
        audienceId: mockAudienceId,
        recurrenceParameters: null,
        endTime: '2061-01-09T11:47:41.596Z',
        messagePriority: 0,
        eventTypeCategory: null
    };

    const resetEvent = () => {
        mockInstruction.presentationType = 'ONCE_OFF';
        mockInstruction.audienceType = 'ALL_USERS';
        mockInstruction.templates = { template: { 'DEFAULT': testRecurringTemplate }};
        mockInstruction.audienceId = mockAudienceId;
    };

    const mockPersistableObject = (instruction = mockInstruction) => ({
        instructionId: mockInstructionId,
        creatingUserId: mockUserId,
        startTime: sinon.match.string,
        endTime: sinon.match.string,
        presentationType: instruction.presentationType,
        processedStatus: instruction.presentationType === 'ONCE_OFF' ? 'READY_FOR_GENERATING' : 'CREATED',
        active: true,
        audienceType: instruction.audienceType,
        templates: instruction.templates,
        audienceId: instruction.audienceId,
        recurrenceParameters: instruction.recurrenceParameters,
        lastProcessedTime: testTime.format(),
        messagePriority: instruction.messagePriority,
        flags: instruction.presentationType === 'EVENT_DRIVEN' ? [instruction.eventTypeCategory] : []
    });

    const commonAssertions = (result, statusCode, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        testHelper.resetStubs(insertMessageInstructionStub, updateMessageInstructionStub, getMessageInstructionStub,
            getCurrentInstructionsStub, alterInstructionStatesStub, lamdbaInvokeStub, momentStub, uuidStub);
        resetEvent();
        uuidStub.returns(mockInstructionId);
        momentStub.returns({
            format: () => testTime.format(),
            add: () => testTime.add(500, 'years')
        });
        mockInstruction.requestContext = { authorizer: { systemWideUserId: mockUserId }};
    });

    it('Inserts new message intruction', async () => {
        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { template: { 'DEFAULT': testRecurringTemplate }},
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };
        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'INSTRUCT_STORED');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Inserts new message intruction and populates messages table', async () => {
        Reflect.deleteProperty(mockInstruction, 'audienceId');
        
        const mockInvocation = {
            FunctionName: 'message_user_create_once',
            InvocationType: 'Event',
            LogType: 'None',
            Payload: JSON.stringify({instructions: [{ instructionId: mockInstructionId }]})
        };

        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction creation:', resultOfInsertion);
     
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'FIRED_INSTRUCT');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);

        expect(insertMessageInstructionStub).to.have.been.calledOnceWithExactly(mockPersistableObject(mockInstruction));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Inserts new message intruction and tests message process', async () => {
        const mockInvocation = {
            FunctionName: 'message_user_create_once',
            InvocationType: 'Event',
            LogType: 'None',
            Payload: stringify({instructions: [{ instructionId: mockInstructionId, destinationUserId: mockUserId }]})
        };
        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);
        mockInstruction.fireTestMessage = true;

        const resultOfInsertion = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction creation:', resultOfInsertion);

        Reflect.deleteProperty(mockInstruction, 'fireTestMessage');

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'FIRED_TEST');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnceWithExactly(mockPersistableObject(mockInstruction));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Sets instruction flags based on presentation type', async () => {
        mockInstruction.presentationType = 'EVENT_DRIVEN';
        mockInstruction.eventTypeCategory = 'REFERRAL';
        mockInstruction.fireTestMessage = true;
        
        const testInstruction = mockPersistableObject(mockInstruction);

        const mockInvocation = {
            FunctionName: 'message_user_create_once',
            InvocationType: 'Event',
            LogType: 'None',
            Payload: stringify({instructions: [{ instructionId: mockInstructionId, destinationUserId: mockUserId }]})
        };

        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction creation:', resultOfInsertion);

        Reflect.deleteProperty(mockInstruction, 'fireTestMessage');

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'FIRED_TEST');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnceWithExactly(sinon.match(testInstruction));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Inserts instruction for scheduled once off message', async () => {
        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { template: { 'DEFAULT': testRecurringTemplate }},
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                startTime: moment().add(2, 'days').format(),
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };
        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'INSTRUCT_STORED');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Handles message sequences', async () => {
        const anchorMessage = { ...testRecurringTemplate };
        anchorMessage.followsPriorMessage = false;
        anchorMessage.hasFollowingMessage = true;
        const subsequentMessage = { ...anchorMessage };
        subsequentMessage.followsPriorMessage = true;

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { sequence: [anchorMessage, subsequentMessage, subsequentMessage] },
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'INSTRUCT_STORED');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Fails on unauthorized instruction insertion', async () => {
        const mockApiInstruction = { ...mockInstruction };
        Reflect.deleteProperty(mockApiInstruction, 'requestContext');
        mockApiInstruction.httpMethod = 'POST';

        const resultOfInsertion = await handler.insertMessageInstruction(mockApiInstruction);
        logger('Result of unauthorized instruction insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 403);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('should throw an error on missing required property value', async () => {
        const expectedResult = { message: 'Missing required property value: presentationType' };
        mockInstruction.presentationType = null;

        const result = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction insertion on missing required property value:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('it should throw an error on missing recurrance instruction where presentation type is RECURRING', async () => {
        const expectedResult = { message: 'recurrenceParameters is required where presentationType is set to RECURRING.' };
        mockInstruction.presentationType = 'RECURRING';

        const result = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction insertion on missing required recurrance instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing audience ID on individual notification', async () => {
        mockInstruction.audienceId = null;
        const expectedResult = { message: 'Audience ID required on indivdual notification.' };
        mockInstruction.audienceType = 'INDIVIDUAL';

        const result = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('should throw an error on missing selection instruction on group notification', async () => {
        mockInstruction.audienceId = null;
        const expectedResult = { message: 'Audience ID required on group notification.' };
        mockInstruction.audienceType = 'GROUP';

        const result = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction insertion on missing required selection instruction:', result);

        commonAssertions(result, 500, expectedResult);
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('Fail on missing property in single template', async () => {
        const invalidTemplate = {
            title: 'Watch your savings grow',
            body: 'Since July 2019 you have earned R40.57 in #{total_interest}! Keep adding cash to your Pluto account to earn more each month for nothing. ',
            actionToTake: 'VIEW_HISTORY'
        };

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { template: { 'DEFAULT': invalidTemplate }},
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Missing required property in message template definition: display');
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Fails where message sequence is not in array', async () => {
        const anchorMessage = { ...testRecurringTemplate };
        anchorMessage.followsPriorMessage = false;
        anchorMessage.hasFollowingMessage = true;
        const subsequentMessage = { ...anchorMessage };
        subsequentMessage.followsPriorMessage = true;

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { sequence: { anchorMessage, subsequentMessage } },
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Message sequence must be contained within an array');
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Fails where message sequence array is empty', async () => {
        const anchorMessage = { ...testRecurringTemplate };
        anchorMessage.followsPriorMessage = false;
        anchorMessage.hasFollowingMessage = true;
        const subsequentMessage = { ...anchorMessage };
        subsequentMessage.followsPriorMessage = true;

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { sequence: [] },
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Message sequence cannot be empty');
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Fails on missing properties in messages within sequence', async () => {
        const anchorMessage = { ...testRecurringTemplate };
        anchorMessage.followsPriorMessage = false;
        anchorMessage.hasFollowingMessage = true;
        const subsequentMessage = { ...anchorMessage };
        subsequentMessage.followsPriorMessage = true;
        const invalidMessage = { ...subsequentMessage };
        Reflect.deleteProperty(invalidMessage, 'display');

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { sequence: [anchorMessage, subsequentMessage, invalidMessage] },
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Missing required property in message template definition: display');
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Fails where initial message in sequence has no subsequent messages', async () => {
        const anchorMessage = { ...testRecurringTemplate };
        anchorMessage.followsPriorMessage = false;
        anchorMessage.hasFollowingMessage = false;

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { sequence: [anchorMessage] },
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);
       
        const expectedError = 'Invalid message sequence definition. Single template messages cannot be disguised as message sequences.';

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', expectedError);
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Fails on non continuous message sequence', async () => {
        const anchorMessage = { ...testRecurringTemplate };
        anchorMessage.followsPriorMessage = false;
        anchorMessage.hasFollowingMessage = true;
        const subsequentMessage = { ...anchorMessage };
        subsequentMessage.followsPriorMessage = false;

        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { sequence: [anchorMessage, subsequentMessage, subsequentMessage] },
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Invalid message sequence definintion. Sequence is non-continuous.');
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('should throw an error on missing templates', async () => {
        mockInstruction.templates = { };

        const resultOfInsertion = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction insertion on missing templates:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Templates must define either a sequence or a single template.');
        expect(insertMessageInstructionStub).to.have.not.been.called;
    });

    it('Fails on missing eventTypeCategory where instruction presentationType is EVENT_DRIVEN', async () => {
        Reflect.deleteProperty(mockInstruction, 'eventTypeCategory');
        mockInstruction.presentationType = 'EVENT_DRIVEN';

        const resultOfInsertion = await handler.insertMessageInstruction(mockInstruction);
        logger('Result of message instruction insertion on missing event type category:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Instructions for event driven must specify the event type');
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;     
    });
});

describe('*** UNIT TEST SCHEDULED MESSAGE INSERTION ***', () => {
    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockAudienceId = uuid();

    const instructionHandler = proxyquire('../msg-instruction-handler', {
        './persistence/rds.notifications': {
            'insertMessageInstruction': insertMessageInstructionStub
        },
        '@noCallThru': true
    });

    beforeEach(() => {
        testHelper.resetStubs(insertMessageInstructionStub, updateMessageInstructionStub, getMessageInstructionStub,
            getCurrentInstructionsStub, alterInstructionStatesStub, lamdbaInvokeStub, momentStub, uuidStub);
        uuidStub.returns(mockInstructionId);
    });

    it('Inserts instruction for scheduled once off message', async () => {
        const testStartTime = moment().add(2, 'minutes');
        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { template: { 'DEFAULT': testRecurringTemplate }},
                audienceId: mockAudienceId,
                recurrenceParameters: null,
                messagePriority: 0,
                startTime: testStartTime.format()
            }),
            requestContext: testHelper.requestContext(mockUserId)
        };
        insertMessageInstructionStub.resolves([{ instructionId: mockInstructionId, creationTime: mockCreationTime }]);

        const resultOfInsertion = await instructionHandler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'INSTRUCT_STORED');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });
});

describe('*** UNIT TESTING MESSAGE INSTRUCTION UPDATE ***', () => {

    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockInsertionId = 111;
    const mockUpdateTime = '2049-06-22T07:38:30.016Z';

    beforeEach(() => {
        testHelper.resetStubs(insertMessageInstructionStub, updateMessageInstructionStub, getMessageInstructionStub,
            getCurrentInstructionsStub, alterInstructionStatesStub, lamdbaInvokeStub, momentStub, uuidStub);
    });

    it('Updates message instruction', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, { }).returns([{ insertionId: mockInsertionId, updateTime: mockUpdateTime }]);
        alterInstructionStatesStub.resolves({ result: 'SUCCESS' });
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: {},
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 200);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body)[0];
        expect(body).to.have.property('insertionId', mockInsertionId);
        expect(body).to.have.property('updateTime', mockUpdateTime);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { });
        expect(alterInstructionStatesStub).to.have.not.been.called;
    });

    it('Updates message instruction and alters instruction message state', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, { active: false }).returns([{ insertionId: mockInsertionId, updateTime: mockUpdateTime }]);
        alterInstructionStatesStub.resolves({ result: 'SUCCESS' });
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: { active: false },
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 200);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body)[0];
        expect(body).to.have.property('insertionId', mockInsertionId);
        expect(body).to.have.property('updateTime', mockUpdateTime);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { 'active': false });
        expect(alterInstructionStatesStub).to.have.been.calledOnceWithExactly(mockInstructionId, ['CREATED', 'READY_FOR_SENDING'], 'DEACTIVATED', null);
    });

    it('Updates message instruction and alters instruction message state and endtime', async () => {
        const currentTime = moment();
        updateMessageInstructionStub.withArgs(mockInstructionId, { active: false }).returns([{ insertionId: mockInsertionId, updateTime: mockUpdateTime }]);
        alterInstructionStatesStub.resolves({ result: 'SUCCESS' });
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: { active: false },
            endTime: currentTime,
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 200);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body)[0];
        expect(body).to.have.property('insertionId', mockInsertionId);
        expect(body).to.have.property('updateTime', mockUpdateTime);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { 'active': false });
        expect(alterInstructionStatesStub).to.have.been.calledOnceWithExactly(mockInstructionId, ['CREATED', 'READY_FOR_SENDING'], 'DEACTIVATED', currentTime);
    });

    it('Fails on unauthorized update', async () => {
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: { active: false }
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of unauthorized instruction update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 403);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(updateMessageInstructionStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, { active: true }).throws(new Error('A persistence derived error.'));
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: { active: true },
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation on persistence error:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 500);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body);
        expect(body).to.have.property('message', 'A persistence derived error.');
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { active: true });
    });
});

describe('*** UNIT TESTING MESSAGE INSTRUCTION EXTRACTION ***', () => {

    const mockInstructionId = uuid();
    const mockInstructionIdOnError = uuid();
    const mockAudienceId = uuid();
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
        audienceId: mockAudienceId,
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
        testHelper.resetStubs(insertMessageInstructionStub, updateMessageInstructionStub, getMessageInstructionStub,
            getCurrentInstructionsStub, alterInstructionStatesStub, lamdbaInvokeStub, momentStub, uuidStub);
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
        getMessageInstructionStub.withArgs(mockInstructionIdOnError).throws(new Error('A persistence derived error.'));
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

describe('*** UNIT TESTING MESSAGE LISTING ****', () => {
    const mockUserId = uuid();
    const mockActiveInstruction = {
        instructionId: '2017f7e5-00e2-42c7-9783-d776734ca3f3',
        creatingUserId: 'ab345be0-6d0e-4b09-9258-d0d29e85d320',
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        presentationType: null,
        processedStatus: 'CREATED',
        active: true,
        audienceType: 'ALL_USERS',
        templates: null,
        audienceId: uuid(),
        recurrenceParameters: null,
        lastProcessedTime: '2019-09-18T11:07:42+02:00',
        messagePriority: 0,
        unfetchedMessageCount: 3
    };

    beforeEach(() => {
        testHelper.resetStubs(insertMessageInstructionStub, updateMessageInstructionStub, getMessageInstructionStub,
            getCurrentInstructionsStub, alterInstructionStatesStub, lamdbaInvokeStub, momentStub, uuidStub);
    });

    it('Returns list of active user messages', async () => {
        getCurrentInstructionsStub.withArgs(false).resolves([mockActiveInstruction, mockActiveInstruction]);
        const mockEvent = {
            body: JSON.stringify({ includeStillDelivering: false }),
            requestContext: testHelper.requestContext(mockUserId)
        };

        const result = await handler.listActiveMessages(mockEvent);
        logger('Result of active message listing:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 200);
        expect(result).to.have.property('headers');
        expect(result.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(result).to.have.property('body', JSON.stringify([mockActiveInstruction, mockActiveInstruction]));
        expect(getCurrentInstructionsStub).to.have.been.calledOnceWithExactly(false);
    });

    it('Fails on unauthorized user', async () => {
        const mockEvent = { includeStillDelivering: false };

        const resultOfListing = await handler.listActiveMessages(mockEvent);
        logger('Result of unauthorized listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 403);
        expect(resultOfListing).to.have.property('headers');
        expect(resultOfListing.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(getCurrentInstructionsStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getCurrentInstructionsStub.withArgs(true).throws(new Error('ProcessError'));
        const mockEvent = {
            includeStillDelivering: true,
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfListing = await handler.listActiveMessages(mockEvent);
        logger('Result of unauthorized listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 500);
        expect(resultOfListing).to.have.property('headers');
        expect(resultOfListing.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfListing).to.have.property('body', JSON.stringify('ProcessError'));
        expect(getCurrentInstructionsStub).to.have.been.calledOnceWithExactly(true);
    });

});
