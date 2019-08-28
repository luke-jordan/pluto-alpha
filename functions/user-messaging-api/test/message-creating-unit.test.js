'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testHelper = require('./message.test.helper');

const getMessageInstructionStub = sinon.stub();
const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const getInstructionsByTypeStub = sinon.stub();
const getPushTokenStub = sinon.stub();
const deletePushTokenStub = sinon.stub();
const insertPushTokenStub = sinon.stub();
const momentStub = sinon.stub();

const handler = proxyquire('../message-creating-handler', {
    './persistence/rds.notifications': {
        'getMessageInstruction': getMessageInstructionStub,
        'getUserIds': getUserIdsStub,
        'insertUserMessages': insertUserMessagesStub,
        'getInstructionsByType': getInstructionsByTypeStub,
        'getPushToken': getPushTokenStub,
        'deletePushToken': deletePushTokenStub,
        'insertPushToken': insertPushTokenStub,
        '@noCallThru': true
    },
    'moment': momentStub
});

const resetStubs = () => testHelper.resetStubs(getMessageInstructionStub, getUserIdsStub, insertUserMessagesStub,
    getInstructionsByTypeStub, getPushTokenStub, deletePushTokenStub, insertPushTokenStub, momentStub);

const simpleCardMsgTemplate = require('./templates/simpleTemplate');
const simpleMsgVariant = require('./templates/variantTemplate');
const referralMsgVariant = require('./templates/referralTemplate');
const recurringMsgTemplate = require('./templates/recurringTemplate')

describe('*** UNIT TESTING USER MESSAGE INSERTION ***', () => {

    const mockInstructionId = uuid();
    const mockUserId = uuid();
    const mockClientId = uuid();
    const mockBoostId = uuid();
    
    const createMockUserIds = (quantity) => Array(quantity).fill().map(() => uuid());
    
    const testTime = moment();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';

    const mockTemplate = {
        template: {
            DEFAULT: simpleCardMsgTemplate
        }
    };

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: mockTemplate,
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 100
    };

    // not including message ID else have either spurious fails or a lot of unnecessary complexity
    const mockUserMessage = (userId, msgTemplate = mockTemplate.template['DEFAULT'], variant = 'DEFAULT') => ({
        destinationUserId: userId,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z', 
        messageTitle: msgTemplate.title,
        messageBody: msgTemplate.body,
        messageVariant: variant,
        display: msgTemplate.display,
        instructionId: mockInstructionId,
        messagePriority: 100,
        presentationType: 'ONCE_OFF',
        followsPriorMessage: false,
        hasFollowingMessage: false,
        actionContext: {
            actionToTake: msgTemplate.actionToTake, ...msgTemplate.actionContext
        }
    }); 

    const resetInstruction = () => {
        mockInstruction.audienceType = 'ALL_USERS';
        mockInstruction.selectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
        mockInstruction.templates = mockTemplate;
    };
    
    const expectedInsertionRows = (quantity, start = 1) => 
        Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    beforeEach(() => {
        resetStubs();
        resetInstruction();
        momentStub.returns(testTime);
    });

    it('Should insert notification messages for all users in current universe', async () => {
        const testNumberUsers = 1000;

        const testUserIds = createMockUserIds(testNumberUsers);
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        
        const expectedResult = { numberMessagesCreated: testNumberUsers, creationTimeMillis: mockCreationTime.valueOf() };
        
        const result = await handler.createUserMessages({ instructionId: mockInstructionId });
        logger('Result of user messages insertion:', result);

        testHelper.standardOkayChecks(result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;

        // testing all one thousand would be very painful, so we sample and test
        const testUserMsgs = testUserIds.map((userId) => mockUserMessage(userId));
        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];

        expect(insertUserMsgArgs).to.be.an('array').of.length(testNumberUsers);
        
        const userIdToTest = testUserIds[Math.floor(Math.random() * testNumberUsers)];
        logger('Testing for user ID: ', userIdToTest);

        const testMessage = insertUserMsgArgs[0];
        expect(testMessage).to.have.property('messageId');
        Reflect.deleteProperty(testMessage, 'messageId');
        expect(testMessage).to.deep.equal(testUserMsgs[0]);
    });

    it('should use other templates over default where provided', async () => {
        const testNumberUsers = 1000;
        const testUserIds = createMockUserIds(testNumberUsers);

        mockInstruction.templates = {
            template: {
                DEFAULT: simpleCardMsgTemplate,
                VARIANT: simpleMsgVariant
            }
        };

        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        
        const expectedResult = { numberMessagesCreated: testNumberUsers, creationTimeMillis: mockCreationTime.valueOf() };
        
        const result = await handler.createUserMessages({ instructionId: mockInstructionId });
        logger('Result of user messages insertion:', result);
        
        testHelper.standardOkayChecks(result, expectedResult);

        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;

        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];

        const testDefaultMsg = mockUserMessage(testUserIds[0]);
        const testVariantMsg = mockUserMessage(testUserIds[1], simpleMsgVariant, 'VARIANT');
        
        const defaultTester = (msg) => Object.keys(testDefaultMsg).filter((key) => key !== 'destinationUserId')
            .reduce((soFar, key) => soFar && JSON.stringify(msg[key]) === JSON.stringify(testDefaultMsg[key]), true);
        const variantTester = (msg) => Object.keys(testVariantMsg).filter((key) => key !== 'destinationUserId')
            .reduce((soFar, key) => soFar && JSON.stringify(msg[key]) === JSON.stringify(testVariantMsg[key]), true);
        logger('Tester works? : ', defaultTester(insertUserMsgArgs[0]));
        logger('And other tests? : ', variantTester(insertUserMsgArgs[0]));
        
        expect(insertUserMsgArgs).to.be.an('array').of.length(testNumberUsers);
        const defaultCount = insertUserMsgArgs.map((msg) => defaultTester(msg) ? 1 : 0).reduce((sum, cum) => sum + cum, 0);
        const variantCount = insertUserMsgArgs.map((msg) => variantTester(msg) ? 1 : 0).reduce((sum, cum) => sum + cum, 0);
        logger('Default count: ', defaultCount, ' and variant count: ', variantCount);
        
        // we might want to range these in future, but for now, make sure not all default
        expect(defaultCount + variantCount).to.equal(testNumberUsers);
        expect(defaultCount).to.be.lessThan(testNumberUsers);
        expect(variantCount).to.be.greaterThan(0);
    });

    it('Should insert sequences properly', async () => {
        const testNumberUsers = 10;
        const testUserIds = createMockUserIds(testNumberUsers);

        mockInstruction.templates = {
            sequence: [
                { DEFAULT: simpleCardMsgTemplate, identifier: 'openingMsg' },
                { DEFAULT: simpleMsgVariant, identifier: 'unlockedMsg' }
            ]
        };

        const expectedNumberMessages = testNumberUsers * mockInstruction.templates.sequence.length;
        logger('Expecting ', expectedNumberMessages, ' messages');

        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(expectedNumberMessages));

        const expectedResult = { numberMessagesCreated: expectedNumberMessages, creationTimeMillis: mockCreationTime.valueOf() };
        const result = await handler.createUserMessages({ instructionId: mockInstructionId });

        testHelper.standardOkayChecks(result, expectedResult);

        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        
        // and todo : also check for inserting message sequence dict
        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(expectedNumberMessages);
        const expectedOpeningMsg = mockUserMessage(testUserIds[0]);
        expectedOpeningMsg.hasFollowingMessage = true;
        const expectedSecondMsg = mockUserMessage(testUserIds[0], mockInstruction.templates.sequence[1].DEFAULT);  // still 'DEFAULT' in its position
        expectedSecondMsg.followsPriorMessage = true;

        const firstMsgToPers = insertUserMsgArgs[0];
        const secondMsgToPers = insertUserMsgArgs[1];

        expect(firstMsgToPers).to.have.property('messageId');
        expect(secondMsgToPers).to.have.property('messageId');

        const expectedMsgSequence = {
            'openingMsg': firstMsgToPers.messageId,
            'unlockedMsg': secondMsgToPers.messageId
        };

        expect(firstMsgToPers).to.have.property('messageSequence');
        expect(firstMsgToPers.messageSequence).to.deep.equal(expectedMsgSequence);
        expect(secondMsgToPers).to.have.property('messageSequence');
        expect(secondMsgToPers.messageSequence).to.deep.equal(expectedMsgSequence);

        expectedOpeningMsg.messageId = firstMsgToPers.messageId;
        expectedOpeningMsg.messageSequence=  firstMsgToPers.messageSequence;
        expectedSecondMsg.messageId = secondMsgToPers.messageId;
        expectedSecondMsg.messageSequence = secondMsgToPers.messageSequence;

        expect(insertUserMsgArgs[0]).to.deep.equal(expectedOpeningMsg);
        expect(insertUserMsgArgs[1]).to.deep.equal(expectedSecondMsg);
    });

    it('should insert boost notification message from boost api', async () => {

        const testReferringUser = uuid();
        const testReferredUser = uuid();

        const mockBoostInstruction = {
            instructionId: mockInstructionId,
            presentationType: 'EVENT_DRIVEN',
            active: true,
            audienceType: 'INDIVIDUAL',
            templates: { 
                template: {
                    DEFAULT: referralMsgVariant
                }
            },
            selectionInstruction: `whole_universe from #{{"specific_users":["${testReferringUser}","${testReferredUser}"]}}`,
            recurrenceInstruction: null,
            responseAction: 'VIEW_HISTORY',
            responseContext: JSON.stringify({ boostId: mockBoostId }),
            startTime: '2050-09-01T11:47:41.596Z',
            endTime: '2061-01-09T11:47:41.596Z',
            lastProcessedTime: moment().format(),
            messagePriority: 0
        };

        getMessageInstructionStub.resolves(mockBoostInstruction);
        getUserIdsStub.withArgs(mockBoostInstruction.selectionInstruction).resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));

        const expectedResult = { numberMessagesCreated: 1, creationTimeMillis: mockCreationTime.valueOf() };
        const mockEvent = {
            instructionId: mockInstructionId,
            destination: mockUserId,
            parameters: { boostAmount: '$10', boostAmountOther: '$20' },
            triggerBalanceFetch: true
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('result of boost message insertion:', result);

        testHelper.standardOkayChecks(result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockBoostInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;

        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(1);

        const messageBody = insertUserMsgArgs[0].messageBody;
        const expectedMsgBody = 'Busani Ndlovu has signed up to Jupiter using your referral code, earning you a $10 boost to your savings. He also earned $20';
        logger('Message body: ', messageBody);
        expect(messageBody).to.be.equal(expectedMsgBody);
    });

    it('should normalize event in body', async () => {
        const testNumberUsers = 1;
        const testUserIds = createMockUserIds(testNumberUsers);
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        
        const expectedResult = { numberMessagesCreated: testNumberUsers, creationTimeMillis: mockCreationTime.valueOf() };
        
        const mockEvent = { body: JSON.stringify({ instructionId: mockInstructionId })};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        testHelper.standardOkayChecks(result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should selection instruction should default to null where not provided (for the love of full coverage)', async () => {
        mockInstruction.selectionInstruction = null;
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns([]);
        
        const expectedResult = { result: 'NO_USERS' };
        const mockEvent = { instructionId: mockInstructionId };

        const result = await handler.createUserMessages(mockEvent);
        
        testHelper.standardOkayChecks(result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.not.have.been.called;
    });

    it('should insert user message on individual user', async () => {
        mockInstruction.audienceType = 'INDIVIDUAL';
        mockInstruction.selectionInstruction = `whole_universe from #{'{"specific_users":["${mockUserId}"]}'}`;
        
        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        
        const expectedResult = { numberMessagesCreated: 1, creationTimeMillis: mockCreationTime.valueOf() };

        const result = await handler.createUserMessages({ instructionId: mockInstructionId });
        
        testHelper.standardOkayChecks(result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should insert user messages on a group of users', async () => {
        const numberSampledUsers = 7500;

        mockInstruction.audienceType = 'GROUP';
        mockInstruction.selectionInstruction = `random_sample #{0.75} from #{'{"client_id":"${mockClientId}"}'}`;
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).resolves(createMockUserIds(numberSampledUsers));
        insertUserMessagesStub.resolves(expectedInsertionRows(numberSampledUsers));
        
        const expectedResult = { numberMessagesCreated: numberSampledUsers, creationTimeMillis: mockCreationTime.valueOf() };
        
        const result = await handler.createUserMessages({ instructionId: mockInstructionId });
        
        testHelper.standardOkayChecks(result, expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        const insertedMessages = insertUserMessagesStub.getCall(0).args[0];
        expect(insertedMessages).to.be.an('array').of.length(numberSampledUsers);
    });

    it('should return an error on instruction extraction failure', async () => {
        getMessageInstructionStub.withArgs(mockInstructionId).rejects(new Error('Error extracting message instruction'));
        const expectedResult = { message: 'Error extracting message instruction' };

        const result = await handler.createUserMessages({ instructionId: mockInstructionId });
        logger('Result of failing intruction extraction:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 500);
        expect(result).to.have.property('body', JSON.stringify(expectedResult));
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
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
        templates: { template: { DEFAULT: recurringMsgTemplate }},
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
            { insertionId: 1, creationTime: mockCreationTime },
            { insertionId: 2, creationTime: mockCreationTime },
            { insertionId: 3, creationTime: mockCreationTime }
        ]);
        const expectedResult = { 
            message: [
                { insertionId: 1, creationTime: mockCreationTime },
                { insertionId: 2, creationTime: mockCreationTime },
                { insertionId: 3, creationTime: mockCreationTime }
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

describe('*** UNIT TESTING PUSH TOKEN INSERTION HANDLER ***', () => {

    const commonAssertions = (statusCode, result, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
    });

    it('should persist push token pair', async () => {
        const mockUserId = uuid();
        const mockPushToken = uuid();
        const mockProvider = uuid();
        const mockCreationTime = '2049-06-22T07:38:30.016Z';
        const mockTokenObject = { userId: mockUserId, pushProvider: mockProvider, pushToken: mockPushToken };
        getPushTokenStub.withArgs(mockProvider, mockUserId).resolves();
        deletePushTokenStub.withArgs(mockProvider, mockUserId).resolves({
            command: 'DELETE',
            rowCount: 1,
            oid: null,
            rows: []
        });
        insertPushTokenStub.withArgs(mockTokenObject).resolves([ { insertionId: 1, creationTime: mockCreationTime }]);

        const expectedResult = { insertionId: 1, creationTime: mockCreationTime };
        
        const mockBody = {
            userId: mockUserId,
            provider: mockProvider,
            token: mockPushToken
        };

        const mockEvent = testHelper.wrapEvent(mockBody, mockUserId, 'ORDINARY_USER');

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token persistence:', result);

        commonAssertions(200, result, expectedResult);
        expect(getPushTokenStub).to.has.been.calledOnceWithExactly(mockProvider, mockUserId);
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.been.calledOnceWithExactly(mockTokenObject);
    });
    
    it('should replace old push token if exists', async () => {
        const mockUserId = uuid();
        const mockPushToken = uuid();
        const mockPersistedProvider = uuid();
        const mockCreationTime = '2049-06-22T07:38:30.016Z';
        const mockPersistableToken = { userId: mockUserId, pushProvider: mockPersistedProvider, pushToken: mockPushToken };
        const mockPersistedToken = {
            insertionId: 1,
            creationTime: mockCreationTime,
            userId: mockUserId,
            pushProvider: mockPersistedProvider,
            pushToken: mockPushToken,
            active: true
        };

        getPushTokenStub.withArgs(mockPersistedProvider, mockUserId).resolves(mockPersistedToken);
        deletePushTokenStub.withArgs(mockPersistedProvider, mockUserId).resolves({
            command: 'DELETE',
            rowCount: 1,
            oid: null,
            rows: []
        });

        insertPushTokenStub.withArgs(mockPersistableToken).resolves([ { insertionId: 1, creationTime: mockCreationTime }]);

        const expectedResult = { insertionId: 1, creationTime: mockCreationTime };
        
        const mockBody = {
            userId: mockUserId,
            provider: mockPersistedProvider,
            token: mockPushToken
        };

        const mockEvent = testHelper.wrapEvent(mockBody, mockUserId, 'ORDINARY_USER');

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token persistence:', result);

        commonAssertions(200, result, expectedResult);
        expect(getPushTokenStub).to.has.been.calledOnceWithExactly(mockPersistedProvider, mockUserId);
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(mockPersistedProvider, mockUserId);
        expect(insertPushTokenStub).to.have.been.calledOnceWithExactly(mockPersistableToken);
    });

    it('should return error on missing request context', async () => {
        const mockUserId = uuid();
        const mockProvider = uuid();
        const mockPushToken = uuid();

        const mockEvent = {
            userId: mockUserId,
            provider: mockProvider,
            token: mockPushToken
        };

        const expectedResult = { statusCode: 403 };

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token insertion on missing request context:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getPushTokenStub).to.have.not.been.called;
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.not.been.called;
    });

    // uncomment if needed. 
    // it('should return error on user token insertion by different user', async () => {
    //     const mockUserId = uuid();
    //     const mockAlienUserId = uuid();
    //     const mockProvider = uuid();
    //     const mockPushToken = uuid();

    //     const mockBody = {
    //         userId: mockUserId,
    //         provider: mockProvider,
    //         token: mockPushToken
    //     };

    //     const mockEvent = testHelper.wrapEvent(mockBody, mockAlienUserId, 'ORDINARY_USER');

    //     const expectedResult = { statusCode: 403 };

    //     const result = await handler.insertPushToken(mockEvent);
    //     logger('Result of push token insertion on missing request context:', result);

    //     expect(result).to.exist;
    //     expect(result).to.deep.equal(expectedResult);
    //     expect(getPushTokenStub).to.have.not.been.called;
    //     expect(deletePushTokenStub).to.have.not.been.called;
    //     expect(insertPushTokenStub).to.have.not.been.called;
    // });

    it('should return error on push token persistence failure', async () => {
        const mockUserId = uuid();
        const mockPushToken = uuid();
        const mockProviderOnError = uuid();
        getPushTokenStub.withArgs(mockProviderOnError, mockUserId).throws(new Error('A persistence derived error.'));
       
        const expectedResult = { result: 'ERROR', details: 'A persistence derived error.' };

        const mockBody = {
            userId: mockUserId,
            provider: mockProviderOnError,
            token: mockPushToken
        };

        const mockEvent = testHelper.wrapEvent(mockBody, mockUserId, 'ORDINARY_USER');

        const result = await handler.insertPushToken(mockEvent);
        logger('Result of push token insertion on persistence failure:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly(mockProviderOnError, mockUserId);
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.not.been.called;
    });
});

describe('*** UNIT TESTING DELETE PUSH TOKEN HANDLER ***', () => {
    const mockUserId = uuid();
    const mockUserIdOnError = uuid();
    const mockAlienUserId = uuid();
    const mockProvider = uuid();

    beforeEach(() => {
        resetStubs();
    });

    it('should delete persisted push token', async () => {
        const mockBody = {
            provider: mockProvider,
            userId: mockUserId
        };
    
        deletePushTokenStub.withArgs(mockProvider, mockUserId).resolves([]);

        const mockEvent = testHelper.wrapEvent(mockBody, mockUserId, 'ORDINARY_USER');
        const expectedResult = { result: 'SUCCESS', details: [] };

        const result = await handler.deletePushToken(mockEvent);
        logger('Result of push token deletion:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(mockProvider, mockUserId);
    });

    it('should return an error missing request context', async () => {
        const mockEvent = {
            provider: mockProvider,
            userId: mockUserId
        };

        const expectedResult = { statusCode: 403 };

        const result = await handler.deletePushToken(mockEvent);
        logger('Result of push token deletion on missing request context:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(deletePushTokenStub).to.have.not.been.called;
    });

    it('should return error when called by different user other that push token owner', async () => {
        const mockBody = {
            provider: mockProvider,
            userId: mockUserId
        };

        const mockEvent = testHelper.wrapEvent(mockBody, mockAlienUserId, 'ORDINARY');
        const expectedResult = { statusCode: 403 };

        const result = await handler.deletePushToken(mockEvent);
        logger('Result of user push token deletion by different user:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(deletePushTokenStub).to.have.not.been.called;
    });

    it('should return error on general process failure', async () => {
        const mockBody = {
            provider: mockProvider,
            userId: mockUserIdOnError
        };

        deletePushTokenStub.withArgs(mockProvider, mockUserIdOnError).throws(new Error('Persistence error'));
        const mockEvent = testHelper.wrapEvent(mockBody, mockUserIdOnError, 'ORDINARY_USER');

        const expectedResult = { result: 'ERROR', details: 'Persistence error' };

        const result = await handler.deletePushToken(mockEvent);
        logger('Result of push token deletion on general process failure:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(mockProvider, mockUserIdOnError);
    });
});
