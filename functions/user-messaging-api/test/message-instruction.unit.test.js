'use strict';

const logger = require('debug')('jupiter:user-notifications:create-msg-instruction-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testRecurringTemplate = require('./templates/recurringTemplate');

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


const resetStubs = () => {
    insertMessageInstructionStub.reset();
    updateMessageInstructionStub.reset();
    getMessageInstructionStub.reset();
    getCurrentInstructionsStub.reset();
    alterInstructionStatesStub.reset();
    lamdbaInvokeStub.reset();
    momentStub.reset();
    uuidStub.reset();
};

describe('*** UNIT TESTING MESSAGE INSTRUCTION INSERTION ***', () => {
    
    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockClientId = uuid();
    const testTime = moment();

    const mockEvent = {
        presentationType: 'ONCE_OFF',
        audienceType: 'ALL_USERS',
        templates: { template: { 'DEFAULT': testRecurringTemplate }},
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceParameters: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        messagePriority: 0
    };

    const resetEvent = () => {
        mockEvent.presentationType = 'ONCE_OFF';
        mockEvent.audienceType = 'ALL_USERS';
        mockEvent.defaultTemplate = config.get('instruction.templates.default');
        mockEvent.selectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
    };

    const mockPersistableObject = (mockInstruction) => ({
        instructionId: mockInstructionId,
        creatingUserId: mockUserId,
        startTime: mockInstruction.startTime ? mockInstruction.startTime : moment().format(),
        endTime: mockInstruction.endTime ? mockInstruction.endTime : moment().add(500, 'years').format(),
        presentationType: mockInstruction.presentationType,
        processedStatus: mockInstruction.presentationType === 'ONCE_OFF' ? 'READY_FOR_SENDING' : 'CREATED',
        active: true,
        audienceType: mockInstruction.audienceType,
        templates: mockInstruction.templates,
        selectionInstruction: mockInstruction.selectionInstruction ? mockInstruction.selectionInstruction : null,
        recurrenceParameters: mockInstruction.recurrenceParameters,
        lastProcessedTime: testTime.format(),
        messagePriority: mockInstruction.messagePriority
    });

    const commonAssertions = (result, statusCode, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs(); // use test helper
        resetEvent();
        uuidStub.returns(mockInstructionId);
        momentStub.returns({
            format: () => testTime.format(),
            add: () => testTime.add(500, 'years')
        });
        mockEvent.requestContext = { authorizer: { systemWideUserId: mockUserId }};
    });

    it('Insert new message intruction and populates messages table', async () => {
        const mockInvocation = {
            FunctionName: 'message_user_create_once',
            InvocationType: 'Event',
            LogType: 'None',
            Payload: JSON.stringify({instructionId: mockInstructionId})
        };
        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        insertMessageInstructionStub.withArgs(mockPersistableObject(mockEvent)).resolves([ { instructionId: mockInstructionId, creationTime: mockCreationTime } ]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfInsertion.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'FIRED_INSTRUCT');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnceWithExactly(mockPersistableObject(mockEvent));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Inserts new message intruction and tests message process', async () => {
        const mockInvocation = {
            FunctionName: 'message_user_create_once',
            InvocationType: 'Event',
            LogType: 'None',
            Payload: JSON.stringify({ instructionId: mockInstructionId, destinationUserId: mockUserId })
        };
        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        insertMessageInstructionStub.withArgs(mockPersistableObject(mockEvent)).resolves([ { instructionId: mockInstructionId, creationTime: mockCreationTime } ]);
        mockEvent.fireTestMessage = true;

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        Reflect.deleteProperty(mockEvent, 'fireTestMessage');

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfInsertion.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('processResult', 'FIRED_TEST');
        expect(body).to.have.property('message');
        expect(body.message).to.have.property('instructionId', mockInstructionId);
        expect(body.message).to.have.property('creationTime', mockCreationTime);
        expect(insertMessageInstructionStub).to.have.been.calledOnceWithExactly(mockPersistableObject(mockEvent));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Inserts new message intruction', async () => {
        const mockEvent = {
            body: JSON.stringify({
                presentationType: 'ONCE_OFF',
                audienceType: 'ALL_USERS',
                templates: { template: { 'DEFAULT': testRecurringTemplate }},
                selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
                recurrenceParameters: null,
                messagePriority: 0,
                holdFire: true
            }),
            requestContext: {
                authorizer: {
                    systemWideUserId: mockUserId
                }
            }
        };
        insertMessageInstructionStub.resolves([ { instructionId: mockInstructionId, creationTime: mockCreationTime } ]);

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction creation:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 200);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfInsertion.headers).to.have.property('Access-Control-Allow-Origin', '*');
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
        Reflect.deleteProperty(mockEvent, 'requestContext');

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of unauthorized instruction insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 403);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfInsertion.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfInsertion).to.have.property('body', JSON.stringify({}));
        expect(insertMessageInstructionStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('it should throw an error on missing recurrance instruction where presentation type is RECURRING', async () => {
        const expectedResult = { message: 'recurrenceParameters is required where presentationType is set to RECURRING.' };
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
        mockEvent.templates = { };

        const resultOfInsertion = await handler.insertMessageInstruction(mockEvent);
        logger('Result of message instruction insertion on missing templates:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('statusCode', 500);
        expect(resultOfInsertion).to.have.property('headers');
        expect(resultOfInsertion.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfInsertion.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.have.property('message', 'Templates must define either a sequence or a single template.')
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

describe('*** UNIT TESTING MESSAGE INSTRUCTION UPDATE ***', () => {

    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockInsertionId = 111;
    const mockUpdateTime = '2049-06-22T07:38:30.016Z';

    beforeEach(() => {
        resetStubs();
    });

    it('Updates message instruction', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, { }).returns([ { insertionId: mockInsertionId, updateTime: mockUpdateTime } ]);
        alterInstructionStatesStub.resolves({ result: 'SUCCESS' });
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: {},
            requestContext: {
                authorizer: {
                    systemWideUserId: mockUserId
                }
            }
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 200);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfUpdate.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body)[0];
        expect(body).to.have.property('insertionId', mockInsertionId);
        expect(body).to.have.property('updateTime', mockUpdateTime);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { });
        expect(alterInstructionStatesStub).to.have.not.been.called;
    });

    it('Updates message instruction and alters instruction message state', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, { active: false }).returns([ { insertionId: mockInsertionId, updateTime: mockUpdateTime } ]);
        alterInstructionStatesStub.resolves({ result: 'SUCCESS' });
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: { active: false },
            requestContext: {
                authorizer: {
                    systemWideUserId: mockUserId
                }
            }
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 200);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfUpdate.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body)[0];
        expect(body).to.have.property('insertionId', mockInsertionId);
        expect(body).to.have.property('updateTime', mockUpdateTime);
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { 'active': false });
        expect(alterInstructionStatesStub).to.have.been.calledOnceWithExactly(mockInstructionId, ['CREATED', 'READY_FOR_SENDING'], 'DEACTIVATED');
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
        expect(resultOfUpdate.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfUpdate.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(updateMessageInstructionStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        updateMessageInstructionStub.withArgs(mockInstructionId, { active: true }).throws( new Error('A persistence derived error.'));
        const mockEvent = {
            instructionId: mockInstructionId,
            updateValues: { active: true },
            requestContext: {
                authorizer: {
                    systemWideUserId: mockUserId
                }
            }
        };

        const resultOfUpdate = await handler.updateInstruction(mockEvent);
        logger('Result of message instruction deactivation on persistence error:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 500);
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfUpdate.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfUpdate).to.have.property('body');
        const body = JSON.parse(resultOfUpdate.body);
        expect(body).to.have.property('message', 'A persistence derived error.');
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, { active: true });
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
        selectionInstruction: 'whole_universe from #{{"client_id":"72d08e86-6641-435e-bf9c-68c7a6c71512"}}',
        recurrenceParameters: null,
        lastProcessedTime: '2019-09-18T11:07:42+02:00',
        messagePriority: 0,
        unfetchedMessageCount: 3
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Returns list of active user messages', async () => {
        getCurrentInstructionsStub.withArgs(false).resolves([mockActiveInstruction, mockActiveInstruction]);
        const mockEvent = {
            body: JSON.stringify({ includeStillDelivering: false }),
            requestContext: {
                authorizer: {
                    systemWideUserId: mockUserId
                }
            }
        };

        const result = await handler.listActiveMessages(mockEvent);
        logger('Result of active message listing:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 200);
        expect(result).to.have.property('headers');
        expect(result.headers).to.have.property('Content-Type', 'application/json');
        expect(result.headers).to.have.property('Access-Control-Allow-Origin', '*');
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
        expect(resultOfListing.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfListing.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(getCurrentInstructionsStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getCurrentInstructionsStub.withArgs(true).throws(new Error('ProcessError'));
        const mockEvent = {
            includeStillDelivering: true,
            requestContext: {
                authorizer: {
                    systemWideUserId: mockUserId
                }
            }
        };

        const resultOfListing = await handler.listActiveMessages(mockEvent);
        logger('Result of unauthorized listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 500);
        expect(resultOfListing).to.have.property('headers');
        expect(resultOfListing.headers).to.have.property('Content-Type', 'application/json');
        expect(resultOfListing.headers).to.have.property('Access-Control-Allow-Origin', '*');
        expect(resultOfListing).to.have.property('body', JSON.stringify('ProcessError'));
        expect(getCurrentInstructionsStub).to.have.been.calledOnceWithExactly(true);
    });

});