'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
// const config = require('config');

const uuid = require('uuid/v4');
const moment = require('moment');
const stringify = require('json-stable-stringify');

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
const sendSmsStub = sinon.stub();

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
    './persistence/rds.pushtokens': {
        'getPushTokens': getPushTokenStub,
        'insertPushToken': insertPushTokenStub,
        'deletePushToken': deletePushTokenStub
    },
    './persistence/rds.usermessages': {
        'getPendingOutboundMessages': getPendingOutboundMessagesStub,
        'bulkUpdateStatus': bulkUpdateStatusStub
    },
    './message-picking-handler': {
        'assembleMessage': assembleMessageStub
    },
    'expo-server-sdk': { Expo: MockExpo },
    'publish-common': {
        'publishUserEvent': publishUserEventStub,
        'sendSms': sendSmsStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

const resetStubs = () => helper.resetStubs(sendPushNotificationsAsyncStub, chunkPushNotificationsStub, getPendingOutboundMessagesStub,
    bulkUpdateStatusStub, getPushTokenStub, insertPushTokenStub, deletePushTokenStub, assembleMessageStub, publishUserEventStub, lamdbaInvokeStub, sendSmsStub);

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
        expect(result).to.deep.equal({ channel: 'PUSH', result: 'SUCCESS', numberSent: 2 });
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
        expect(result).to.deep.equal({ channel: 'PUSH', result: 'SUCCESS', numberSent: 2 });
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
        expect(result).to.deep.equal({ channel: 'PUSH', result: 'SUCCESS', numberSent: 1 });
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
        expect(result).to.deep.equal({ channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 });
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
        expect(result).to.deep.equal({ channel: 'PUSH', result: 'ERROR', message: 'PersistenceError' });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(getPushTokenStub).to.have.been.calledOnce;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.throws(new Error('PersistenceError'));

        const result = await handler.sendPushNotifications();
        logger('Result of push notification sending:', result);
        expect(result).to.exist;
        expect(result).to.deep.equal({ channel: 'PUSH', result: 'ERR', message: 'PersistenceError' });
        expect(getPendingOutboundMessagesStub).to.have.been.calledOnceWithExactly('PUSH');
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(getPushTokenStub).to.have.not.been.called;
    });

});

describe('*** UNIT EMAIL MESSAGE DISPATCH ***', () => {
    const testUserId = uuid();
    const testInstructionId = uuid();

    const testUpdateTime = moment().format(); 

    const template = '<p>Greetings {{user}}. Welcome to Jupiter.</p>';

    const testPhoneProfile = {
        systemWideUserId: testUserId,
        personalName: 'John',
        familyName: 'Doe',
        phoneNumber: '278384748264'
    };

    const testEmailProfile = {
        systemWideUserId: testUserId,
        personalName: 'Jane',
        familyName: 'Doe',
        emailAddress: 'user@email.com'
    };

    const mockUserMessage = () => ({
        destinationUserId: uuid(),
        display: {
            type: 'CARD',
            titleType: 'EMPHASIS',
            iconType: 'BOOST_ROCKET',
            backupSms: 'Greetings. Welcome to Jupiter.'
        },
        messageBody: template,
        messageTitle: 'Welcome to Jupiter',
        messageId: uuid(),
        instructionId: testInstructionId
    });

    const mockMessageBase = {
        messageId: uuid(),
        title: 'Welcome to jupiter. ',
        body: 'Greetings. Welcome to jupiter.',
        display: {
            type: 'CARD',
            titleType: 'EMPHASIS',
            iconType: 'BOOST_ROCKET',
            backupSms: 'Greetings. Welcome to Jupiter.'
        },
        priority: 1
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Sends pending push messages and emails', async () => {
        getPendingOutboundMessagesStub.resolves([mockUserMessage(), mockUserMessage(), mockUserMessage(), mockUserMessage()]);
        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);
        
        const numberEmailProfileCalls = 2;
        const profileResponse = helper.mockLambdaResponse({ statusCode: 200, body: stringify(testEmailProfile) });
        Array(numberEmailProfileCalls).fill().forEach((_, index) => lamdbaInvokeStub.onCall(index).returns({ promise: () => profileResponse }));
        lamdbaInvokeStub.onCall(2).returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testPhoneProfile) })});
        lamdbaInvokeStub.onCall(3).returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testPhoneProfile) })});

        
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });

        const expectedResult = { channel: 'EMAIL', result: 'SUCCESS', numberSent: 4 };

        const result = await handler.sendEmailMessages();
        logger('Result of email dispatch:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        // Stub args are asserted in handler.sendOutbandMessages tests.
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL');
        expect(bulkUpdateStatusStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub.callCount).to.equal(5);
        expect(assembleMessageStub.callCount).to.equal(4);
    });

    it('Returns where no pending emails are found', async () => {
        getPendingOutboundMessagesStub.resolves([]);

        const expectedResult = { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 };

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

        const expectedResult = { channel: 'EMAIL', result: 'ERR', message: 'Update error' };

        const result = await handler.sendEmailMessages();
        logger('Result of email dispatch:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).have.been.calledOnceWithExactly('EMAIL');
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(assembleMessageStub).to.have.not.been.called;
        expect(publishUserEventStub).to.have.not.been.called;
    });
});

describe('*** UNIT TEST PUSH AND EMAIL SCHEDULED JOB ***', async () => {
    const testUserId = uuid();
    const testMessageId = uuid();
    const testInstructionId = uuid();
    const mockProvider = uuid();
    const persistedToken = uuid();

    const testUpdateTime = moment().format(); 

    const template = 'Greetings {{user}}. Welcome to Jupiter.';

    const testUserProfile = {
        systemWideUserId: testUserId,
        personalName: 'John',
        familyName: 'Doe',
        phoneNumber: '278384748264',
        emailAddress: 'user@email.com'
    };

    const mockUserMessage = {
        destinationUserId: testUserId,
        messageBody: template,
        messageTitle: 'Welcome to Jupiter',
        messageId: testMessageId,
        instructionId: testInstructionId
    };

    const emailMessagesInvocation = {
        FunctionName: 'outbound_comms_send',
        InvocationType: 'RequestResponse',
        LogType: 'None',
        Payload: stringify({
            emailWrapper: {
                s3key: 'emails/messageEmailWrapper.html',
                s3bucket: 'jupiter.templates'
            },
            emailMessages: [{
                messageId: testMessageId,
                to: 'user@email.com',
                from: 'hello@jupitersave.com',
                subject: 'Welcome to jupiter.',
                text: 'Greetings. Welcome to jupiter.',
                html: '<p>Greetings. Welcome to jupiter.</p>'
            }]
        })
    };

    const mockMessageBase = {
        instructionId: testInstructionId,
        messageId: testMessageId,
        title: 'Welcome to jupiter.',
        body: '<p>Greetings. Welcome to jupiter.</p>'
    };

    beforeEach(() => {
        resetStubs();
    });

    it('It sends out push and email messages', async () => {
        getPendingOutboundMessagesStub.resolves([mockUserMessage]);
        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testUserProfile) }) });
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });

        getPushTokenStub.resolves({ [testUserId]: persistedToken });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const expectedResult = [
            { channel: 'PUSH', result: 'SUCCESS', numberSent: 2 },
            { channel: 'EMAIL', result: 'SUCCESS', numberSent: 1 }
        ];

        const result = await handler.sendOutboundMessages();
        logger('result of scheduled job:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).have.been.calledTwice;
        expect(getPendingOutboundMessagesStub).have.been.calledWith('PUSH');
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL');

        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMessageId], 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMessageId], 'SENT');
        expect(bulkUpdateStatusStub.callCount).to.equal(4);

        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc('profile_fetch', false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(emailMessagesInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledTwice;

        expect(assembleMessageStub).to.have.been.calledWith(mockUserMessage);
        expect(publishUserEventStub).to.have.been.calledWith(testUserId, 'MESSAGE_PUSH_NOTIFICATION_SENT', { context: mockMessageBase });
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([testUserId]);
        expect(chunkPushNotificationsStub).to.have.been.calledOnce;

        expect(sendPushNotificationsAsyncStub).to.have.been.calledTwice;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk2');
    });

    it('Sends emails and push messages to specific users', async () => {
        const testEmailProfile = { ...testUserProfile };
        const testPhoneProfile = { ...testUserProfile };
        Reflect.deleteProperty(testPhoneProfile, 'emailAddress');
        testPhoneProfile.systemWideUserId = uuid();

        const expectedEmail = {
            messageId: testUserId,
            to: 'user@email.com',
            from: 'hello@jupitersave.com',
            subject: 'Welcome to jupiter.',
            text: 'Greetings. Welcome to Jupiter.',
            html: '<p>Greetings. Welcome to Jupiter.</p>'
        };

        const expectedWrapper = {
            s3bucket: 'jupiter.templates',
            s3key: 'emails/messageEmailWrapper.html'
        };

        const expectedInvocation = {
            FunctionName: 'outbound_comms_send',
            InvocationType: 'RequestResponse',
            LogType: 'None',
            Payload: stringify({ emailMessages: [expectedEmail, expectedEmail], emailWrapper: expectedWrapper })
        };

        getPendingOutboundMessagesStub.resolves([mockUserMessage]);
        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testEmailProfile) }) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testEmailProfile) }) });
        lamdbaInvokeStub.onThirdCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testPhoneProfile) }) });
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });

        getPushTokenStub.resolves({ [testUserId]: persistedToken });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const expectedResult = [
            { channel: 'PUSH', result: 'SUCCESS', numberSent: 2 },
            { channel: 'EMAIL', result: 'SUCCESS', numberSent: 3 }
        ];

        const testParams = {
            systemWideUserIds: [testUserId, testUserId, testUserId],
            provider: mockProvider,
            title: 'Welcome to jupiter.',
            body: '<p>Greetings. Welcome to Jupiter.</p>',
            backupSms: 'Greetings. Welcome to Jupiter.'
        };

        const result = await handler.sendOutboundMessages(testParams);
        logger('result of scheduled job:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc('profile_fetch', false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedInvocation);
        expect(lamdbaInvokeStub.callCount).to.deep.equal(4);

        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([testUserId, testUserId, testUserId], mockProvider);
        expect(chunkPushNotificationsStub).to.have.been.calledOnce;

        expect(sendPushNotificationsAsyncStub).to.have.been.calledTwice;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk2');

        expect(sendSmsStub).to.have.been.calledOnceWithExactly({ phoneNumber: '+278384748264', message: 'Greetings. Welcome to Jupiter.' });

        expect(assembleMessageStub).have.not.been.called;
        expect(publishUserEventStub).have.not.been.called;
        expect(bulkUpdateStatusStub).have.not.been.called;
        expect(getPendingOutboundMessagesStub).have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.throws(new Error('Internal error'));

        const expectResult = [
            { channel: 'PUSH', result: 'ERR', message: 'Internal error' },
            { channel: 'EMAIL', result: 'ERR', message: 'Internal error' }
        ];

        const result = await handler.sendOutboundMessages();
        logger('result of scheduled job:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectResult);

        expect(getPendingOutboundMessagesStub).have.been.calledTwice;
        expect(getPendingOutboundMessagesStub).have.been.calledWith('PUSH');
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL');

        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(assembleMessageStub).to.have.not.been.called;
        expect(publishUserEventStub).to.have.not.been.called;
        expect(getPushTokenStub).to.have.not.been.called;
        expect(chunkPushNotificationsStub).to.have.not.been.called;
        expect(sendPushNotificationsAsyncStub).to.have.not.been.called;
    });
});
