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

// config.picker.push.running = true; // todo: modify test order to run this test first

const sendPushNotificationsAsyncStub = sinon.stub();
const chunkPushNotificationsStub = sinon.stub();
const getPendingPushMessagesStub = sinon.stub();
const bulkUpdateStatusStub = sinon.stub();
const getPushTokenStub = sinon.stub();
const insertPushTokenStub = sinon.stub();
const deletePushTokenStub = sinon.stub();
const assembleMessageStub = sinon.stub();

// class MockExpo {
//     constructor () {
//         this.chunkPushNotifications = expo.chunkPushNotifications;
//         this.sendPushNotificationsAsync = sendPushNotificationsAsyncStub
//     }
// }

const handler = proxyquire('../message-push-handler', {
    './persistence/rds.notifications': {
        'getPushTokens': getPushTokenStub,
        'insertPushToken': insertPushTokenStub,
        'deletePushToken': deletePushTokenStub
    },
    './persistence/rds.msgpicker': {
        'getPendingPushMessages': getPendingPushMessagesStub,
        'bulkUpdateStatus': bulkUpdateStatusStub
    },
    './message-picking-handler': {
        'assembleMessage': assembleMessageStub
    }
});

const resetStubs = () => testHelper.resetStubs(sendPushNotificationsAsyncStub, chunkPushNotificationsStub, getPendingPushMessagesStub,
    bulkUpdateStatusStub, getPushTokenStub, insertPushTokenStub, deletePushTokenStub, assembleMessageStub);

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
        deletePushTokenStub.resolves([]);
        insertPushTokenStub.resolves([{ 'insertionId': 1, 'creationTime': mockCreationTime }]);

        const mockEvent = {
            provider: expectedProvider,
            token: expectedToken,
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfInsertion = await handler.insertPushToken(mockEvent);
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

    it('Fails on missing authorization', async () => {
        const expectedProvider = uuid();
        const expectedToken = uuid();
        const mockEvent = { provider: expectedProvider, token: expectedToken };

        const resultOfInsertion = await handler.insertPushToken(mockEvent);
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
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfInsertion = await handler.insertPushToken(mockEvent);
        logger('Result of token insertion:', resultOfInsertion);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion.statusCode).to.equal(500);
        expect(resultOfInsertion.headers).to.deep.equal(testHelper.expectedHeaders);
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


    it('Deletes push token', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        deletePushTokenStub.resolves([]);

        const mockEvent = {
            provider: expectedProvider,
            userId: mockUserId,
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion.statusCode).to.equal(200);
        expect(resultOfDeletion.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS', details: [] }));
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(expectedProvider, mockUserId);
    });

    it('Fails on missing authorization', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        const mockEvent = { provider: expectedProvider, userId: mockUserId };

        deletePushTokenStub.resolves([]);

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of unauthorized token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion).to.deep.equal({ statusCode: 403 });
        expect(deletePushTokenStub).to.have.not.been.called;
    });

    it('Fails on authorization-event user mismatch', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        deletePushTokenStub.resolves([]);

        const mockEvent = {
            provider: expectedProvider,
            userId: uuid(),
            requestContext: testHelper.requestContext(mockUserId)
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
            provider: expectedProvider,
            userId: mockUserId,
            requestContext: testHelper.requestContext(mockUserId)
        };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);
        logger('Result of token deletion:', resultOfDeletion);

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion.statusCode).to.equal(500);
        expect(resultOfDeletion.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfDeletion.body).to.deep.equal(JSON.stringify('PersistenceError'));
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly(expectedProvider, mockUserId);
    });
});

describe('*** UNIT TESTING PUSH NOTIFICATION SENDING ***', () => {
    const mockUserId = uuid();
    const persistedToken = uuid();
    const testMsgId = uuid();

    const minimalMessage = { messageId: testMsgId, destinationUserId: mockUserId };

    beforeEach(() => {
        resetStubs();
    });

    it('Sends push notifications', async () => {
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });

        const mockParams = {
            systemWideUserIds: [mockUserId, mockUserId],
            title: 'TEST_TITLE',
            body: 'TEST_BODY'
        };

        const result = await handler.sendPushNotifications(mockParams);
        logger('Result of push notification sending:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'SUCCESS', numberSent: 2 });
    });

    // todo: chunking, expected stub args
    it('Sends pending messages where no user ids are provided', async () => {
        getPendingPushMessagesStub.resolves([minimalMessage, minimalMessage]);
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.resolves({ [mockUserId]: persistedToken });

        const result = await handler.sendPushNotifications();
        logger('Result of push notification sending:', result);  

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'SUCCESS', numberSent: 2 });
        expect(getPendingPushMessagesStub).to.have.been.calledOnce;
        expect(getPushTokenStub).to.have.been.calledOnce;
        expect(bulkUpdateStatusStub).to.have.been.calledTwice;
    });
    
    it('Fails on push token extraction failure', async () => {
        getPendingPushMessagesStub.resolves([minimalMessage, minimalMessage]);
        bulkUpdateStatusStub.resolves([]);
        getPushTokenStub.throws(new Error('PersistenceError'));

        const result = await handler.sendPushNotifications();
        logger('Result of push notification sending:', result); 

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'ERROR', message: 'PersistenceError' });
        expect(getPendingPushMessagesStub).to.have.been.calledOnce;
        expect(getPushTokenStub).to.have.been.calledOnce;
    });

    it('Catches thrown errors', async () => {
        getPendingPushMessagesStub.throws(new Error('PersistenceError'));

        const result = await handler.sendPushNotifications();
        logger('Result of push notification sending:', result);
        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'ERR', message: 'PersistenceError' });
        expect(getPendingPushMessagesStub).to.have.been.calledOnce;
        expect(bulkUpdateStatusStub).to.have.not.been.called;
        expect(getPushTokenStub).to.have.not.been.called;
    });

});
