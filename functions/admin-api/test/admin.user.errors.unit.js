'use strict';

const logger = require('debug')('jupiter:admin:user-handler-test');
const config = require('config');
const moment = require('moment');

const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test.helper');

const momentStub = sinon.stub();
const publishEventStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const updateBsheetTagStub = sinon.stub();
const insertAccountLogStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-user-manage', {
    './persistence/rds.account': {
        'updateBsheetTag': updateBsheetTagStub,
        'insertAccountLog': insertAccountLogStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishEventStub,
        '@noCallThru': true
    },
    './admin.util': {},
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

const testAccountId = uuid();
const testAdminId = uuid();
const testUserId = uuid();
const testTxId = uuid();

const testCreationTime = moment().format();

// todo: find a more efficient way to test this
describe('*** UNIT TEST USER MANAGEMENT ERRORS AND INVALID EVENTS ***', () => {

    beforeEach(() => helper.resetStubs(lamdbaInvokeStub, publishEventStub, insertAccountLogStub, updateBsheetTagStub));

    it('User balance sheet update returns error on persistence failure', async () => {

        updateBsheetTagStub.resolves();
        publishEventStub.resolves({ result: 'SUCCESS' });
        insertAccountLogStub.resolves({ creationTime: testCreationTime });

        const expectedResult = {
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify({ result: 'ERROR', message: 'Failed on persistence update' })
        };

        const requestBody = {
            adminUserId: testAdminId,
            accountId: testAccountId,
            newIdentifier: 'NEW_IDENTIFIER',
            systemWideUserId: testUserId,
            fieldToUpdate: 'BSHEET',
            reasonToLog: 'Updating user balance sheet'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(updateBsheetTagStub).to.have.been.calledOnceWithExactly({
            accountId: testAccountId,
            tagPrefix: 'FINWORKS',
            newIdentifier: 'NEW_IDENTIFIER'
        });

        helper.expectNoCalls(publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('Fails on unauthorized user', async () => {

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            transactionId: testTxId,
            fieldToUpdate: 'TRANSACTION',
            newTxStatus: 'SETTLED',
            reasonToLog: 'Saving event completed'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'ORDINARY_USER');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('User update fails on invalid parameters', async () => {

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            transactionId: testTxId,
            fieldToUpdate: 'TRANSACTION',
            newTxStatus: 'SETTLED',
            reasonToLog: 'Saving event completed'
        };

        const expectedResult = {
            statusCode: 400,
            headers: helper.expectedHeaders,
            body: JSON.stringify('Requests must include a user ID to update, a field, and a reason to log')
        };

        const requiredProperties = ['systemWideUserId', 'fieldToUpdate', 'reasonToLog'];
        requiredProperties.forEach(async (property) => {
            const params = { ...requestBody };
            Reflect.deleteProperty(params, property);
            await expect(handler.manageUser(helper.wrapEvent(params, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);
        });

        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('User status update fails on invalid parameters', async () => {

        const requestBody = {
            systemWideUserId: testUserId,
            fieldToUpdate: 'STATUS',
            newStatus: 'ACCOUNT_OPENED',
            reasonToLog: 'User account opened'
        };

        const expectedResult = {
            statusCode: 400,
            headers: helper.expectedHeaders,
            body: JSON.stringify('Error, bad field or type for user update')
        };

        const testCases = ['KYC', 'STATUS'];

        testCases.forEach(async (testCase) => {
            const params = { ...requestBody };
            params.fieldToUpdate = testCase;
            params.newStatus = 'INVALID_STATUS';
            await expect(handler.manageUser(helper.wrapEvent(params, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);
        });

        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('User balance sheet update fails on missing account ID', async () => {

        const requestBody = {
            adminUserId: testAdminId,
            newIdentifier: 'Test Identifier',
            systemWideUserId: testUserId,
            fieldToUpdate: 'BSHEET',
            reasonToLog: 'Updating user balance sheet'
        };

        const expectedResult = {
            statusCode: 400,
            headers: helper.expectedHeaders,
            body: JSON.stringify('Error, must pass in account ID')
        };

        await expect(handler.manageUser(helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);
        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('User balance sheet update fails on missing new identifier', async () => {

        const requestBody = {
            accountId: testAccountId,
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'BSHEET',
            reasonToLog: 'Updating user balance sheet'
        };

        const expectedResult = {
            statusCode: 400,
            headers: helper.expectedHeaders,
            body: JSON.stringify('Error, must pass in newIdentifier')
        };

        await expect(handler.manageUser(helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);
        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('Catches thrown errors', async () => {

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            transactionId: testTxId,
            fieldToUpdate: 'TRANSACTION',
            newTxStatus: 'SETTLED',
            reasonToLog: 'Saving event completed'
        };

        const expectedInvocation = {
            FunctionName: config.get('lambdas.directSettle'),
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                paymentProvider: 'ADMIN_OVERRIDE',
                paymentRef: 'Saving event completed',
                settlingUserId: testUserId,
                transactionId: testTxId
            })
        };

        const expectedResult = {
            statusCode: 500,
            headers: helper.expectedHeaders,
            body: JSON.stringify('Invocation error')
        };

        lamdbaInvokeStub.throws(new Error('Invocation error'));

        await expect(handler.manageUser(helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub);
    });
});
