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
const getPushTokenStub = sinon.stub();
const getNoPushStub = sinon.stub();

const sendPushNotificationsAsyncStub = sinon.stub();
const chunkPushNotificationsStub = sinon.stub();
const getPendingOutboundMessagesStub = sinon.stub();
const bulkUpdateStatusStub = sinon.stub();
const assembleMessageStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const publishUserEventStub = sinon.stub();
const sendSmsStub = sinon.stub();

const BATCH_SIZE = 20;

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
    './persistence/rds.pushsettings': {
        'getPushTokens': getPushTokenStub,
        'getListOfNoPushUsers': getNoPushStub
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
    bulkUpdateStatusStub, getPushTokenStub, assembleMessageStub, publishUserEventStub, lamdbaInvokeStub, sendSmsStub);

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
        getNoPushStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockMessage = { to: persistedToken, title: 'TEST_TITLE', body: 'TEST_BODY' };
    
        const mockParams = {
            systemWideUserIds: [mockUserId, mockUserId],
            route: 'PUSH',
            provider: mockProvider,
            title: 'TEST_TITLE',
            body: 'TEST_BODY'
        };

        const result = await handler.sendOutboundMessages(mockParams);
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

        getPendingOutboundMessagesStub.withArgs('PUSH').resolves([minimalMessage, minimalMessage]);
        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves([]);

        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        assembleMessageStub.resolves(mockMessageBase);
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockParams = { provider: mockProvider, title: 'TEST_TITLE', body: 'TEST_BODY' };

        const result = await handler.sendOutboundMessages(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([
            { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 },
            { channel: 'PUSH', result: 'SUCCESS', numberSent: 2 }
        ]);

        expect(getPendingOutboundMessagesStub).to.have.been.calledTwice;
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

        getPendingOutboundMessagesStub.withArgs('PUSH').resolves([minimalMessage, minimalMessage]);
        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves([]);

        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        chunkPushNotificationsStub.returns(['expoChunk1', 'expoChunk2']);
        sendPushNotificationsAsyncStub.onFirstCall().throws(new Error('Error dispatching chunk'));
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const mockParams = { provider: mockProvider, title: 'TEST_TITLE', body: 'TEST_BODY' };

        const result = await handler.sendOutboundMessages(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([
            { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 },
            { channel: 'PUSH', result: 'SUCCESS', numberSent: 1 }
        ]);
        
        expect(getPendingOutboundMessagesStub).to.have.been.calledTwice;
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

        const result = await handler.sendOutboundMessages(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([
            { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 },
            { channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 }
        ]);
        expect(getPendingOutboundMessagesStub).to.have.been.calledTwice;
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
        getPendingOutboundMessagesStub.withArgs('PUSH').resolves([minimalMessage, minimalMessage]);
        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves([]);
        
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.throws(new Error('PersistenceError'));

        const result = await handler.sendOutboundMessages();
        logger('Result of push notification sending:', result); 

        expect(result).to.exist;
        expect(result).to.deep.equal([
            { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 },
            { channel: 'PUSH', result: 'ERROR', message: 'PersistenceError' }
        ]);
        expect(getPendingOutboundMessagesStub).to.have.been.calledTwice;
        expect(getPushTokenStub).to.have.been.calledOnce;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.throws(new Error('PersistenceError'));

        const result = await handler.sendOutboundMessages();
        logger('Result of push notification sending:', result);
        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'ERR', message: 'PersistenceError' });
        expect(getPendingOutboundMessagesStub).to.have.been.calledTwice;
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

    const mockAssembledMsg = (msgId, userId) => ({
        destinationUserId: userId,
        messageId: msgId,
        title: 'Welcome to jupiter. ',
        body: 'Greetings. Welcome to jupiter.',
        display: {
            type: 'CARD',
            titleType: 'EMPHASIS',
            iconType: 'BOOST_ROCKET',
            backupSms: 'Greetings. Welcome to Jupiter.'
        },
        priority: 1,
        instructionId: testInstructionId
    });

    beforeEach(() => resetStubs());

    it('Sends pending emails', async () => {
        const mockMessages = [mockUserMessage()];

        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves(mockMessages);
        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);
        
        const profileResponse = helper.mockLambdaResponse({ statusCode: 200, body: stringify(testEmailProfile) });
        mockMessages.forEach((_, index) => lamdbaInvokeStub.onCall(index).returns({ promise: () => profileResponse }));
        
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});
        
        const mockAssembledMsgs = mockMessages.map((msg) => mockAssembledMsg(msg.messageId, msg.destinationUserId));
        mockAssembledMsgs.forEach((msg, index) => assembleMessageStub.onCall(index).resolves(msg));

        publishUserEventStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });

        const expectedResult = [
            { channel: 'EMAIL', result: 'SUCCESS', numberSent: mockMessages.length },
            { channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 }
        ];

        const result = await handler.sendOutboundMessages();

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        // Stub args are asserted in handler.sendOutbandMessages tests.
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL');
        
        expect(bulkUpdateStatusStub).to.have.been.calledTwice;
        expect(bulkUpdateStatusStub).to.have.been.calledWith(mockMessages.map((msg) => msg.messageId), 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith(mockMessages.map((msg) => msg.messageId), 'SENT');
        
        expect(lamdbaInvokeStub.callCount).to.equal(mockMessages.length + 1);
        expect(assembleMessageStub.callCount).to.equal(mockMessages.length);

        expect(publishUserEventStub).to.have.callCount(mockMessages.length);
        mockAssembledMsgs.forEach((msg) => {
            const expectedContext = { channel: 'EMAIL', messageId: msg.messageId, title: msg.title, instructionId: testInstructionId };
            expect(publishUserEventStub).to.have.been.calledWith(msg.destinationUserId, 'MESSAGE_SENT', { context: expectedContext });
        });
    });

    it('Sends pending SMS backup routes', async () => {
        const mockMessage = mockUserMessage();

        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves([mockMessage]);
        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);
        
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testPhoneProfile) })});
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'ERR', message: 'No valid emails found' })});

        assembleMessageStub.resolves(mockAssembledMsg(mockMessage.messageId, mockMessage.destinationUserId));
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });

        const expectedResult = [
            { channel: 'EMAIL', result: 'SUCCESS', numberSent: 1 },
            { channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 }
        ];

        const result = await handler.sendOutboundMessages();

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        // Stub args are asserted in handler.sendOutbandMessages tests.
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL');
        expect(bulkUpdateStatusStub).to.have.been.calledTwice;
        expect(bulkUpdateStatusStub).to.have.been.calledWith([mockMessage.messageId], 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith([mockMessage.messageId], 'SENT');

        expect(lamdbaInvokeStub.callCount).to.equal(2);
        expect(assembleMessageStub.callCount).to.equal(1);
    });

    it('Returns where no pending emails are found', async () => {
        getPendingOutboundMessagesStub.resolves([]);

        const expectedResult = [
            { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 },
            { channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 }
        ];

        const result = await handler.sendOutboundMessages();
        logger('Result of email dispatch:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).to.have.been.calledTwice;
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(assembleMessageStub).to.have.not.been.called;
        expect(publishUserEventStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves([mockUserMessage()]);
        getPendingOutboundMessagesStub.withArgs('PUSH').resolves([]);

        bulkUpdateStatusStub.throws(new Error('Update error'));

        const expectedResult = { result: 'ERR', message: 'Update error' };
        const result = await handler.sendOutboundMessages();

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).have.been.calledWithExactly('EMAIL', BATCH_SIZE);
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
        chunkPushNotificationsStub.returns(['expoChunk1']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const expectedResult = [
            { channel: 'EMAIL', result: 'SUCCESS', numberSent: 1 },
            { channel: 'PUSH', result: 'SUCCESS', numberSent: 1 }
        ];

        const result = await handler.sendOutboundMessages();
        logger('result of scheduled job:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).have.been.calledTwice;
        expect(getPendingOutboundMessagesStub).have.been.calledWith('PUSH');
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL', 20); // lower limit here

        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMessageId], 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMessageId], 'SENT');
        expect(bulkUpdateStatusStub.callCount).to.equal(4);

        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc('profile_fetch', false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(emailMessagesInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledTwice;

        expect(assembleMessageStub).to.have.been.calledWith(mockUserMessage);
        
        const pnLogContext = { ...mockMessageBase, channel: 'PUSH_NOTIFICATION' };
        Reflect.deleteProperty(pnLogContext, 'body');
        const emailLogContext = { ...mockMessageBase, channel: 'PUSH_NOTIFICATION' };
        Reflect.deleteProperty(emailLogContext, 'body'); // sensitive stuff in here, so

        expect(publishUserEventStub).to.have.been.calledTwice;
        expect(publishUserEventStub).to.have.been.calledWith(testUserId, 'MESSAGE_SENT', { context: pnLogContext });
        expect(publishUserEventStub).to.have.been.calledWith(testUserId, 'MESSAGE_SENT', { context: emailLogContext });
        
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([testUserId]);
        expect(chunkPushNotificationsStub).to.have.been.calledOnce;

        expect(sendPushNotificationsAsyncStub).to.have.been.calledOnce;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
    });

    it('Marks as blocked, messages that would have gone to pref set users', async () => {
        const mockBlockedPn = { ...mockUserMessage };
        mockBlockedPn.messageId = 'pn-to-block';
        mockBlockedPn.destinationUserId = 'user-with-msg-block';
        mockBlockedPn.haltPushMessages = true;
    
        const mockBlockedEmail = { ...mockUserMessage };
        mockBlockedEmail.messageId = 'email-to-block';
        mockBlockedEmail.destinationUserId = 'user-with-msg-block';
        mockBlockedEmail.haltPushMessages = true;

        getPendingOutboundMessagesStub.withArgs('PUSH').resolves([mockUserMessage, mockBlockedPn]);
        getPendingOutboundMessagesStub.withArgs('EMAIL', BATCH_SIZE).resolves([mockBlockedEmail]);

        bulkUpdateStatusStub.resolves([{ updatedTime: testUpdateTime }]);

        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testUserProfile) }) });
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});
        
        assembleMessageStub.resolves(mockMessageBase);
        publishUserEventStub.resolves({ result: 'SUCCESS' });

        getPushTokenStub.resolves({ [testUserId]: persistedToken });
        chunkPushNotificationsStub.returns(['expoChunk1']);
        sendPushNotificationsAsyncStub.resolves(['sentTicket']);

        const expectedResult = [
            { channel: 'EMAIL', result: 'SUCCESS', numberSent: 0 },
            { channel: 'PUSH', result: 'SUCCESS', numberSent: 1 }
        ];

        const result = await handler.sendOutboundMessages();
        logger('result of scheduled job:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getPendingOutboundMessagesStub).have.been.calledTwice;
        expect(getPendingOutboundMessagesStub).have.been.calledWith('PUSH');
        expect(getPendingOutboundMessagesStub).have.been.calledWith('EMAIL', BATCH_SIZE); // lower limit here

        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMessageId], 'SENDING');
        expect(bulkUpdateStatusStub).to.have.been.calledWith([testMessageId], 'SENT');
        expect(bulkUpdateStatusStub).to.have.been.calledWith(['pn-to-block'], 'BLOCKED');
        expect(bulkUpdateStatusStub).to.have.been.calledWith(['email-to-block'], 'BLOCKED');
        expect(bulkUpdateStatusStub.callCount).to.equal(4);

        expect(assembleMessageStub).to.have.been.calledOnceWithExactly(mockUserMessage);
        
        const pnLogContext = { ...mockMessageBase, channel: 'PUSH_NOTIFICATION' };
        Reflect.deleteProperty(pnLogContext, 'body');

        expect(publishUserEventStub).to.have.been.calledOnce;
        expect(publishUserEventStub).to.have.been.calledWith(testUserId, 'MESSAGE_SENT', { context: pnLogContext });
        
        expect(getPushTokenStub).to.have.been.calledOnceWithExactly([testUserId]);
        expect(chunkPushNotificationsStub).to.have.been.calledOnce;

        expect(sendPushNotificationsAsyncStub).to.have.been.calledOnce;
        expect(sendPushNotificationsAsyncStub).to.have.been.calledWith('expoChunk1');
    });

    it('Sends emails to specific users', async () => {
        const testEmailProfile = { ...testUserProfile };
        const testPhoneProfile = { ...testUserProfile };
        Reflect.deleteProperty(testPhoneProfile, 'emailAddress');
        testPhoneProfile.systemWideUserId = uuid();

        const expectedEmail = {
            messageId: 'message-X',
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

        getNoPushStub.resolves([]);

        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testEmailProfile) }) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse({ statusCode: 200, body: stringify(testPhoneProfile) }) });
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({ result: 'SUCCESS', failedMessageIds: [] })});

        sendSmsStub.resolves({ result: 'SUCCESS' });

        const expectedResult = { channel: 'EMAIL', result: 'SUCCESS', numberSent: 2 };

        const testParams = {
            systemWideUserIds: ['user-1', 'user-2'],
            route: 'EMAIL',
            provider: mockProvider,
            title: 'Welcome to jupiter.',
            body: '<p>Greetings. Welcome to Jupiter.</p>',
            backupSms: 'Greetings. Welcome to Jupiter.',
            messageId: 'message-X'
        };

        const result = await handler.sendOutboundMessages(testParams);
        expect(result).to.deep.equal(expectedResult);

        const expectedOutboundInvocation = {
            FunctionName: 'outbound_comms_send',
            InvocationType: 'RequestResponse',
            LogType: 'None',
            Payload: stringify({ emailMessages: [expectedEmail], emailWrapper: expectedWrapper })
        };

        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc('profile_fetch', false, { systemWideUserId: 'user-1', includeContactMethod: true }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedOutboundInvocation);
        expect(lamdbaInvokeStub.callCount).to.equal(3);

        expect(sendSmsStub).to.have.been.calledOnceWithExactly({ phoneNumber: '+278384748264', message: 'Greetings. Welcome to Jupiter.' });

        expect(getPushTokenStub).to.not.have.been.called;
        expect(chunkPushNotificationsStub).to.not.have.been.called;
 
        expect(assembleMessageStub).have.not.been.called;
        expect(publishUserEventStub).have.not.been.called;
        expect(bulkUpdateStatusStub).have.not.been.called;
        expect(getPendingOutboundMessagesStub).have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getPendingOutboundMessagesStub.throws(new Error('Internal error'));

        const expectResult = { result: 'ERR', message: 'Internal error' };

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
