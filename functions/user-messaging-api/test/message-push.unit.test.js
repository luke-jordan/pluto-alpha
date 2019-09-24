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
