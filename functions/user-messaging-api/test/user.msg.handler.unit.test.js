'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');

const getMessageInstructionStub = sinon.stub();
const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const getInstructionsByTypeStub = sinon.stub();
const getPushTokenStub = sinon.stub();
const deletePushTokenStub = sinon.stub();
const insertPushTokenStub = sinon.stub();
const momentStub = sinon.stub();

const handler = proxyquire('../user-message-handler', {
    './persistence/rds.notifications': {
        'getMessageInstruction': getMessageInstructionStub,
        'getUserIds': getUserIdsStub,
        'insertUserMessages': insertUserMessagesStub,
        'getInstructionsByType': getInstructionsByTypeStub,
        'getPushToken': getPushTokenStub,
        'deletePushToken': deletePushTokenStub,
        'insertPushToken': insertPushTokenStub
    },
    'moment': momentStub
});

const resetStubs = () => {
    getMessageInstructionStub.reset();
    getUserIdsStub.reset();
    insertUserMessagesStub.reset();
    getInstructionsByTypeStub.reset();
    getPushTokenStub.reset();
    deletePushTokenStub.reset();
    insertPushTokenStub.reset();
    momentStub.reset();
};


describe('*** UNIT TESTING USER MESSAGE INSERTION ***', () => {

    const mockUserId = uuid();
    const mockClientId = uuid();
    const mockInstructionId = uuid();
    const mockInstructionIdOnIndividual = uuid();
    const mockInstructionIdOnGroup = uuid();
    const mockInstructionIdOnBoost = uuid();
    const mockInstructionIdOnError = uuid();
    const mockBoostId = uuid();
    const testTime = moment();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockInsertionId = 111;

    // decamelize (or camelize in get call to db) and add properties appended by database
    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: JSON.stringify({
            default: config.get('instruction.templates.default'),
            otherTemplates: null // test on array of template objects of the form {title, body}
        }),
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: JSON.stringify({ boostId: mockBoostId }),
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 0
    };

    const resetInstruction = () => {
        mockInstruction.audienceType = 'ALL_USERS';
        mockInstruction.selectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
    };

    const createMockUserIds = (quantity) => {
        const mockUserIds = [];
        for (let i = 0; i < quantity; i++) {
            mockUserIds.push(uuid());
        };
        logger('created userIds of length:', mockUserIds.length);
        return mockUserIds;
    };

    const expectedInsertionResult = {
        message: [{
            insertion_id: mockInsertionId,
            creation_time: mockCreationTime
        }]
    };

    const commonAssertions = (statusCode, result, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
        resetInstruction();
        momentStub.returns({ format: () => testTime.format() });
    });

    it('should insert notification messages for all users in current universe', async () => {
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns(createMockUserIds(1000));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should normalize event in body', async () => {
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns(createMockUserIds(1000));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            body: JSON.stringify({
                instructionId: mockInstructionId
            })
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should user user other template over default template where provided', async () => {
        mockInstruction.templates = JSON.stringify({
            default: config.get('instruction.templates.default'),
            otherTemplates: 'The world ends at sunrise.'
        });
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns(createMockUserIds(1000));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should selection instruction should default to null where not provided (for the love of full coverage)', async () => {
        mockInstruction.selectionInstruction = null;
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns(createMockUserIds(1000));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should insert user message on individual user', async () => {
        mockInstruction.audienceType = 'INDIVIDUAL';
        mockInstruction.selectionInstruction = `whole_universe from #{'{"specific_users":["${mockUserId}"]}'}`;
        getMessageInstructionStub.withArgs(mockInstructionIdOnIndividual).returns(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns(createMockUserIds(1));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionIdOnIndividual
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnIndividual);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should insert user messages on a group of users', async () => {
        mockInstruction.audienceType = 'GROUP';
        mockInstruction.selectionInstruction = `random_sample #{0.75} from #{'{"client_id":"${mockClientId}"}'}`;
        getMessageInstructionStub.withArgs(mockInstructionIdOnGroup).returns(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns(createMockUserIds(750));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionIdOnGroup
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnGroup);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should insert boost notification message from boost api', async () => {

        const testReferringUser = uuid();
        const testReferredUser = uuid();

        const mockBoostInstruction = {
            instructionId: mockInstructionId,
            presentationType: 'EVENT_DRIVEN',
            active: true,
            audienceType: 'INDIVIDUAL',
            templates: JSON.stringify({
                default: config.get('instruction.templates.default'),
                otherTemplates: config.get('instruction.templates.boost')
            }),
            selectionInstruction: `whole_universe from #{{"specific_users":["${testReferringUser}","${testReferredUser}"]}}`,
            recurrenceInstruction: null,
            responseAction: 'VIEW_HISTORY',
            responseContext: JSON.stringify({ boostId: mockBoostId }),
            startTime: '2050-09-01T11:47:41.596Z',
            endTime: '2061-01-09T11:47:41.596Z',
            lastProcessedTime: moment().format(),
            messagePriority: 0
        };

        getMessageInstructionStub.withArgs(mockInstructionIdOnBoost).returns(mockBoostInstruction);
        getUserIdsStub.withArgs(mockBoostInstruction.selectionInstruction).returns(createMockUserIds(2));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionIdOnBoost,
            destination: mockUserId,
            parameters: { boostAmount: '$10' },
            triggerBalanceFetch: true // consider how to store this in user message
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('result of boost message insertion:', result);

        commonAssertions(200, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnBoost);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockBoostInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should return an error on instruction extraction failure', async () => {
        getMessageInstructionStub.withArgs(mockInstructionIdOnError).throws(new Error('Error extracting message instruction'));
        const mockEvent = {
            instructionId: mockInstructionIdOnError
        };
        const expectedResult = { message: 'Error extracting message instruction' };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of failing intruction extraction:', result);

        commonAssertions(500, result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnError);
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
    });
});


describe('*** UNIT TESTING NEW USER MESSAGE SYNC ***', () => {
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockInstructionId = uuid();
    const mockClientId = uuid();
    const mockUserId = uuid();
    const mockUserIdOnError = uuid();

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: JSON.stringify({
            default: config.get('instruction.templates.default'),
            otherTemplates: 'Welcome to Jupiter savings.'
        }),
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 0
    };

    const commonAssertions = (statusCode, result, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
    });

    it('should populate a new users messages with recurring messages targeted at all users', async () => {
        getInstructionsByTypeStub.withArgs('ALL_USERS', 'RECURRING').resolves([mockInstruction, mockInstruction, mockInstruction]);
        insertUserMessagesStub.returns([
            { insertion_id: 1, creation_time: mockCreationTime },
            { insertion_id: 2, creation_time: mockCreationTime },
            { insertion_id: 3, creation_time: mockCreationTime }
        ]);
        const expectedResult = { 
            message: [
                { insertion_id: 1, creation_time: mockCreationTime },
                { insertion_id: 2, creation_time: mockCreationTime },
                { insertion_id: 3, creation_time: mockCreationTime }
            ]
        };
        
        const mockEvent = {
            systemWideUserId: mockUserId
        };

        const result = await handler.syncUserMessages(mockEvent);
        logger('Result of user messages sync:', result);

        commonAssertions(200, result, expectedResult);
        expect(getInstructionsByTypeStub).to.have.been.calledOnceWithExactly('ALL_USERS', 'RECURRING');
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should return an error on process failure', async () => {
        getInstructionsByTypeStub.withArgs('ALL_USERS', 'RECURRING').throws(new Error('Error extracting instructions'));
        const expectedResult = { message: 'Error extracting instructions' };

        const mockEvent = {
            systemWideUserId: mockUserIdOnError
        };

        const result = await handler.syncUserMessages(mockEvent);
        logger('Result of user messages sync on error:', result);

        commonAssertions(500, result, expectedResult);
        expect(getInstructionsByTypeStub).to.have.been.calledOnceWithExactly('ALL_USERS', 'RECURRING');
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
    });
});

describe('*** UNIT TESTING PUSH TOKEN HANDLER ***', () => {
    const mockUserId = uuid();
    const mockPushToken = uuid();
    const mockPersistedToken = uuid();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';


    beforeEach(() => {
        resetStubs();
    })

    it('should persist provider-token pair', async () => {
        const mockProvider = uuid();
        const mockTokenObject = { userId: mockUserId, pushProvider: mockProvider, pushToken: mockPushToken };
        getPushTokenStub.withArgs(mockProvider).resolves();
        deletePushTokenStub.withArgs(mockProvider).resolves({
            command: 'DELETE',
            rowCount: 1,
            oid: null,
            rows: []
        });
        insertPushTokenStub.withArgs(mockTokenObject).resolves([ { insertion_id: 1, creation_time: mockCreationTime }]);

        const expectedResult = {
            result: 'SUCCESS',
            details: [ { insertion_id: 1, creation_time: mockCreationTime }]
        };
        
        const mockEvent = {
            userId: mockUserId,
            provider: mockProvider,
            token: mockPushToken
        };

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token persistence:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getPushTokenStub).to.has.been.calledOnceWithExactly(mockEvent.provider);
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.been.calledOnceWithExactly(mockTokenObject);
    });
    
    it('should replace old push token if exists', async () => {
        const mockPersistedProvider = uuid();
        const mockTokenObject = { userId: mockUserId, pushProvider: mockPersistedProvider, pushToken: mockPushToken };
        getPushTokenStub.withArgs(mockPersistedProvider).resolves({ provider: mockPersistedProvider, token: mockPersistedToken });
        deletePushTokenStub.withArgs(mockPersistedProvider).resolves({
            command: 'DELETE',
            rowCount: 1,
            oid: null,
            rows: []
        });
        insertPushTokenStub.withArgs(mockTokenObject).resolves([ { insertion_id: 1, creation_time: mockCreationTime }]);

        const expectedResult = {
            result: 'SUCCESS',
            details: [ { insertion_id: 1, creation_time: mockCreationTime }]
        };
        
        const mockEvent = {
            userId: mockUserId,
            provider: mockPersistedProvider,
            token: mockPushToken
        };

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token persistence:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getPushTokenStub).to.has.been.calledOnceWithExactly(mockEvent.provider);
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(mockEvent.provider);
        expect(insertPushTokenStub).to.have.been.calledOnceWithExactly(mockTokenObject);
    });

    it('should return error on push token persistence failure', async () => {
        const mockProviderOnError = uuid();
        getPushTokenStub.withArgs(mockProviderOnError).throws(new Error('A persistence derived error.'));
       
        const expectedResult = { result: 'ERROR', details: 'A persistence derived error.' };

        const mockEvent = {
            userId: mockUserId,
            provider: mockProviderOnError,
            token: mockPushToken
        };

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token insertion on persistence failure:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly(mockProviderOnError);
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.not.been.called;
    });
});