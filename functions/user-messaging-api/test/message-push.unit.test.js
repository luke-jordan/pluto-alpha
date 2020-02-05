'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
// const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const helper = require('./message.test.helper');

// config.picker.push.running = true; // todo: modify test order to run this test first

const sendPushNotificationsAsyncStub = sinon.stub();
const chunkPushNotificationsStub = sinon.stub();
const getPendingOutboundMessagesStub = sinon.stub();
const bulkUpdateStatusStub = sinon.stub();
const getPushTokenStub = sinon.stub();
const insertPushTokenStub = sinon.stub();
const deletePushTokenStub = sinon.stub();
const assembleMessageStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const publishUserEventStub = sinon.stub();

class MockExpo {
    constructor () {
        this.chunkPushNotifications = chunkPushNotificationsStub;
        this.sendPushNotificationsAsync = sendPushNotificationsAsyncStub;
    }
}

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../message-push-handler', {
    './persistence/rds.notifications': {
        'getPushTokens': getPushTokenStub,
        'insertPushToken': insertPushTokenStub,
        'deletePushToken': deletePushTokenStub
    },
    './persistence/rds.msgpicker': {
        'getPendingOutboundMessages': getPendingOutboundMessagesStub,
        'bulkUpdateStatus': bulkUpdateStatusStub
    },
    './message-picking-handler': {
        'assembleMessage': assembleMessageStub
    },
    'expo-server-sdk': { Expo: MockExpo },
    'publish-common': {
        'publishUserEvent': publishUserEventStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

const resetStubs = () => helper.resetStubs(sendPushNotificationsAsyncStub, chunkPushNotificationsStub, getPendingOutboundMessagesStub,
    bulkUpdateStatusStub, getPushTokenStub, insertPushTokenStub, deletePushTokenStub, assembleMessageStub, publishUserEventStub, lamdbaInvokeStub);

describe('*** UNIT TESTING PUSH TOKEN INSERTION HANDLER ***', () => {
    const mockCreationTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Inserts push token:', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        const expectedToken = uuid();
        const persistedToken = uuid();

        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        deletePushTokenStub.resolves({ deleteCount: 1 });
        insertPushTokenStub.resolves([{ 'insertionId': 1, 'creationTime': mockCreationTime }]);

        const mockEvent = {
            provider: expectedProvider,
            token: expectedToken,
            requestContext: helper.requestContext(mockUserId)
        };

        const resultOfInsertion = await handler.managePushToken(mockEvent);
        logger('Result of token insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion.statusCode).to.equal(200);
        expect(resultOfInsertion).to.have.property('body');
        const body = JSON.parse(resultOfInsertion.body);
        expect(body).to.deep.equal({ 'insertionId': 1, 'creationTime': mockCreationTime });
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([mockUserId], expectedProvider);
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(expectedProvider, mockUserId);
        expect(insertPushTokenStub).to.have.been.calledOnceWithExactly({ userId: mockUserId, pushProvider: expectedProvider, pushToken: expectedToken });
    });

    it('Deletes push token', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        const expectedToken = uuid();
        const persistedToken = uuid();

        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        deletePushTokenStub.resolves({ deleteCount: 1 });
        insertPushTokenStub.resolves([{ 'insertionId': 1, 'creationTime': mockCreationTime }]);

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({ result: 'SUCCESS', details: { deleteCount: 1 }})
        }; 

        const mockEvent = {
            provider: expectedProvider,
            token: expectedToken,
            httpMethod: 'DELETE',
            requestContext: {
                authorizer: { systemWideUserId: mockUserId }
            }
        };

        const resultOfInsertion = await handler.managePushToken(mockEvent);
        logger('Result of token insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.deep.equal(expectedResult);
        expect(getPushTokenStub).to.have.not.been.called;
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly({ token: expectedToken, userId: mockUserId });
        expect(insertPushTokenStub).to.have.not.been.called;
    });

    it('Fails on missing authorization', async () => {
        const expectedProvider = uuid();
        const expectedToken = uuid();
        const mockEvent = { provider: expectedProvider, token: expectedToken };

        const resultOfInsertion = await handler.managePushToken(mockEvent);
        logger('Result of unauthorized token insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.deep.equal({ statusCode: 403 });
        expect(getPushTokenStub).to.have.not.been.called;
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        const expectedToken = uuid();

        getPushTokenStub.throws(new Error('PersistenceError'));
    
        const mockEvent = {
            provider: expectedProvider,
            token: expectedToken,
            requestContext: helper.requestContext(mockUserId)
        };

        const resultOfInsertion = await handler.managePushToken(mockEvent);
        logger('Result of token insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion.statusCode).to.equal(500);
        expect(resultOfInsertion.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfInsertion.body).to.deep.equal(JSON.stringify('PersistenceError'));
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([mockUserId], expectedProvider);
        expect(deletePushTokenStub).to.have.not.been.called;
        expect(insertPushTokenStub).to.have.not.been.called;
    });
});


describe('*** UNIT TESTING PUSH TOKEN DELETION ***', () => {

    beforeEach(() => {
        resetStubs();
    });


    it('Deletes push token when given provider in body', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        deletePushTokenStub.resolves({ deleteCount: 2 });

        const mockEvent = {
            body: JSON.stringify({ provider: expectedProvider }),
            requestContext: helper.requestContext(mockUserId)
        };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion.statusCode).to.equal(200);
        expect(resultOfDeletion.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS', details: { deleteCount: 2 } }));
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly({ provider: expectedProvider, userId: mockUserId });
    });

    it('Deletes push token when given token in body', async () => {
        const mockToken = 'THISTOKEN';
        const mockUserId = uuid();
        
        const mockEvent = {
            body: JSON.stringify({ token: mockToken }),
            requestContext: helper.requestContext(mockUserId)
        };

        deletePushTokenStub.resolves({ deleteCount: 1 });
        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        expect(resultOfDeletion).to.exist;
        expect(deletePushTokenStub).have.been.calledOnceWithExactly({ token: mockToken, userId: mockUserId });
    });

    it('Fails on missing authorization', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        const mockEvent = { provider: expectedProvider, userId: mockUserId };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of unauthorized token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion).to.deep.equal({ statusCode: 403 });
        expect(deletePushTokenStub).to.have.not.been.called;
    });

    it('Fails on authorization-event user mismatch', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();

        const mockEvent = {
            provider: expectedProvider,
            userId: uuid(),
            requestContext: helper.requestContext(mockUserId),
            httpMethod: 'DELETE'
        };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion).to.deep.equal({ statusCode: 403 });
        expect(deletePushTokenStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        deletePushTokenStub.throws(new Error('PersistenceError'));

        const mockEvent = {
            body: JSON.stringify({ provider: expectedProvider, userId: mockUserId }),
            requestContext: helper.requestContext(mockUserId)
        };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion.statusCode).to.equal(500);
        expect(resultOfDeletion.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfDeletion.body).to.deep.equal(JSON.stringify('PersistenceError'));
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly({ provider: expectedProvider, userId: mockUserId });
    });
});

describe('*** UNIT TESTING PUSH NOTIFICATION SENDING ***', () => {
    const mockUserId = uuid();
    const mockProvider = uuid();
    const persistedToken = uuid();
    const testMsgId = uuid();

    const minimalMessage = { messageId: testMsgId, destinationUserId: mockUserId };

    beforeEach(() => {
        resetStubs();
    });

    it('Sends push notifications', async () => {
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockMessage = { to: persistedToken, title: 'TEST_TITLE', body: 'TEST_BODY' };
    
        const mockParams = {
            systemWideUserIds: [mockUserId, mockUserId],
            provider: mockProvider,
            title: 'TEST_TITLE',
            body: 'TEST_BODY'
        };

        const result = await handler.sendPushNotifications(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'SUCCESS', numberSent: 2 });
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([mockUserId, mockUserId], mockProvider);
        expect(chunkPushNotificationsStub).to.have.been.calledOnceWithExactly([mockMessage, mockMessage]);
        expect(sendPushNotificationsAsyncStub).to.have.been.calledTwice;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk2');
    });

    it('Sends pending messages where no user ids are provided', async () => {
        const mockMessageBase = {
            messageId: testMsgId,
            title: 'TEST',
            body: 'TEST',
            priority: 1
        };

        getPendingOutboundMessagesStub.resolves([minimalMessage, minimalMessage]);
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        assembleMessageStub.resolves(mockMessageBase);
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockParams = { provider: mockProvider, title: 'TEST_TITLE', body: 'TEST_BODY' };

        const result = await handler.sendPushNotifications(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'SUCCESS', numberSent: 2 });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([mockUserId, mockUserId]);
        expect(bulkUpdateStatusStub).to.have.been.calledTwice;
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMsgId, testMsgId], 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMsgId, testMsgId], 'SENT');
        expect(chunkPushNotificationsStub).to.have.been.calledOnce;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledTwice;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk2');
    });

    it('Gracefully isolates failed message chunks', async () => {
        const mockMessageBase = {
            messageId: testMsgId,
            title: 'TEST',
            body: 'TEST',
            priority: 1
        };

        getPendingOutboundMessagesStub.resolves([minimalMessage, minimalMessage]);
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.onFirstCall().throws(new Error('Error dispatching chunk'));
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockParams = { provider: mockProvider, title: 'TEST_TITLE', body: 'TEST_BODY' };

        const result = await handler.sendPushNotifications(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'SUCCESS', numberSent: 1 });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([mockUserId, mockUserId]);
        expect(bulkUpdateStatusStub).to.have.been.calledTwice;
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMsgId, testMsgId], 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMsgId, testMsgId], 'SENT');
        expect(chunkPushNotificationsStub).to.have.been.calledOnce;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledTwice;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk2');
    });

    it('Reports back where no pending messages found', async () => {
        const mockMessageBase = {
            messageId: testMsgId,
            title: 'TEST',
            body: 'TEST',
            priority: 1
        };

        getPendingOutboundMessagesStub.resolves([]);
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.onFirstCall().throws(new Error('Error dispatching chunk'));
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockParams = { provider: mockProvider, title: 'TEST_TITLE', body: 'TEST_BODY' };

        const result = await handler.sendPushNotifications(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'NONE_PENDING', numberSent: 0 });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(getPushTokenStub).to.have.not.been.called;
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(publishUserEventStub).to.have.not.been.called;
        expect(chunkPushNotificationsStub).to.have.not.been.called;
        expect(sendPushNotificationsAsyncStub).to.have.not.been.called;
        expect(sendPushNotificationsAsyncStub).to.have.not.been.called;
        expect(sendPushNotificationsAsyncStub).to.have.not.been.called;
    });
    
    it('Fails on push token extraction failure', async () => {
        getPendingOutboundMessagesStub.resolves([minimalMessage, minimalMessage]);
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.throws(new Error('PersistenceError'));

        const result = await handler.sendPushNotifications();
        logger('Result of push notification sending:', result); 

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'ERROR', message: 'PersistenceError' });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(getPushTokenStub).to.have.been.calledOnce;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.throws(new Error('PersistenceError'));

        const result = await handler.sendPushNotifications();
        logger('Result of push notification sending:', result);
        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'ERR', message: 'PersistenceError' });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(getPushTokenStub).to.have.not.been.called;
    });

});

describe('*** UNIT EMAIL MESSAGE DISPATCH ***', () => {
    const testUserId = uuid();
    const testClientId = uuid();
    const testFloatId = uuid();
    const testInstructionId = uuid();

    const testNationalId = '91122594738373';
    const testCountryCode = 'ZAF';

    const testUpdateTime = moment().format(); 

    const template = '<p>Greetings {{user}}. Welcome to Jupiter.</p>';

    const testUserProfile = {
        systemWideUserId: testUserId,
        creationTimeEpochMillis: moment().valueOf(),
        clientId: testClientId,
        floatId: testFloatId,
        defaultCurrency: 'USD',
        defaultTimezone: 'America/New_York',
        personalName: 'John',
        familyName: 'Doe',
        phoneNumber: '278384748264',
        emailAddress: 'user@email.com',
        countryCode: testCountryCode,
        nationalId: testNationalId,
        userStatus: 'CREATED',
        kycStatus: 'CONTACT_VERIFIED',
        securedStatus: 'PASSWORD_SET',
        updatedTimeEpochMillis: moment().valueOf()
    };

    const mockUserMessage = () => ({
        destinationUserId: uuid(),
        messageBody: template,
        messageTitle: 'Welcome to Jupiter',
        messageId: uuid(),
        instructionId: testInstructionId
    });

    const mockMessageBase = {
        messageId: uuid(),
        title: 'Welcome to jupiter. ',
        body: 'Greetings. Welcome to jupiter. ',
        priority: 1
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Sends pending push messages and emails', async () => {
        getPendingOutboundMessagesStub.resolves([mockUserMessage(), mockUserMessage(), mockUserMessage(), mockUserMessage()]);
        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);
        lamdbaInvokeStub.onCall(0).returns({ promise: () => helper.mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onCall(1).returns({ promise: () => helper.mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onCall(2).returns({ promise: () => helper.mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onCall(3).returns({ promise: () => helper.mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });

        const expectedResult = { result: 'SUCCESS', numberSent: 4 };

        const result = await handler.sendEmailMessages();
        logger('Result of email dispatch:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        // todo: expectations on stub args
    });

    it('Returns where no pending emails are found', async () => {
        getPendingOutboundMessagesStub.resolves([]);

        const expectedResult = { result: 'NONE_PENDING', numberSent: 0 };

        const result = await handler.sendEmailMessages();
        logger('Result of email dispatch:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).to.have.been.calledOnce;
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(assembleMessageStub).to.have.not.been.called;
        expect(publishUserEventStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.resolves([mockUserMessage(), mockUserMessage(), mockUserMessage(), mockUserMessage()]);
        bulkUpdateStatusStub.throws(new Error('Update error'));

        const expectedResult = { result: 'ERR', message: 'Update error' };

        const result = await handler.sendEmailMessages();
        logger('Result of email dispatch:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        // todo: add more stub expectations       
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(assembleMessageStub).to.have.not.been.called;
        expect(publishUserEventStub).to.have.not.been.called;
    });
});
