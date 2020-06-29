'use strict';

const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const getPushTokenStub = sinon.stub();
const insertPushTokenStub = sinon.stub();
const deletePushTokenStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();
const helper = require('./message.test.helper');

const handler = proxyquire('../message-prefs-handler', {
    './persistence/rds.pushsettings': {
        'getPushTokens': getPushTokenStub,
        'insertPushToken': insertPushTokenStub,
        'deletePushToken': deletePushTokenStub,
        '@noCallThru': true
    }
});

const resetStubs = () => helper.resetStubs(getPushTokenStub, insertPushTokenStub, deletePushTokenStub);

describe('*** UNIT TESTING PUSH TOKEN INSERTION HANDLER ***', () => {
    const mockCreationTime = moment().format();

    beforeEach(resetStubs);

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

    beforeEach(resetStubs);

    it('Deletes push token when given provider in body', async () => {
        const mockUserId = uuid();
        const expectedProvider = uuid();
        deletePushTokenStub.resolves({ deleteCount: 2 });

        const mockEvent = {
            body: JSON.stringify({ provider: expectedProvider }),
            requestContext: helper.requestContext(mockUserId)
        };

        const resultOfDeletion = await handler.deletePushToken(mockEvent);

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

        expect(resultOfDeletion).to.exist;
        expect(resultOfDeletion.statusCode).to.equal(500);
        expect(resultOfDeletion.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfDeletion.body).to.deep.equal(JSON.stringify('PersistenceError'));
        expect(deletePushTokenStub).to.have.been.calledOnceWithExactly({ provider: expectedProvider, userId: mockUserId });
    });
});
