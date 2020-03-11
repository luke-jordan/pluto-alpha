'use strict';

const logger = require('debug')('jupiter:admin:user-handler-test');
const config = require('config');
const moment = require('moment');

const uuid = require('uuid/v4');
const stringify = require('json-stable-stringify');

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
const adjustTxStatusStub = sinon.stub();
const adjustTxAmountStub = sinon.stub();
const fetchBsheetTagStub = sinon.stub();
const updateBsheetTagStub = sinon.stub();
const insertAccountLogStub = sinon.stub();
const fetchTxDetailsStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-user-manage', {
    './persistence/rds.account': {
        'fetchBsheetTag': fetchBsheetTagStub,
        'adjustTxStatus': adjustTxStatusStub,
        'adjustTxAmount': adjustTxAmountStub,
        'updateBsheetTag': updateBsheetTagStub,
        'insertAccountLog': insertAccountLogStub,
        'getTransactionDetails': fetchTxDetailsStub,
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

// some mock values used throughout
const testAccountId = uuid();
const testAdminId = uuid();
const testUserId = uuid();
const testTxId = uuid();

const testCreationTime = moment().format();
const testUpdatedTime = moment().format();

describe('*** UNIT TEST USER MANAGEMENT ***', () => {

    beforeEach(() => helper.resetStubs(fetchTxDetailsStub, lamdbaInvokeStub, publishEventStub, insertAccountLogStub, updateBsheetTagStub, fetchBsheetTagStub));

    it('Settles user transaction', async () => {

        const mockLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                transactionDetails: [
                    { accountTransactionType: 'USER_SAVING_EVENT' }
                ]
            })
        };

        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });
        publishEventStub.resolves({ result: 'SUCCESS' });
        insertAccountLogStub.resolves({ creationTime: testCreationTime });
        fetchTxDetailsStub.resolves({ accountId: testAccountId, humanReference: 'JSAVE111', amount: 100000, unit: 'HUNDREDTH_CENT', currency: 'USD' });
        
        const testLogTime = moment();
        momentStub.returns(testLogTime);

        const expectedLogContext = {
            settleInstruction: {
                transactionId: testTxId,
                paymentRef: 'Saving event completed',
                paymentProvider: 'ADMIN_OVERRIDE',
                settlingUserId: testUserId
            },
            resultPayload: {
                transactionDetails: [{ 'accountTransactionType': 'USER_SAVING_EVENT' }]
            }
        };

        const expectedSaveSettledLog = {
            initiator: testUserId,
            context: {
                transactionId: testTxId,
                accountId: testAccountId,
                timeInMillis: testLogTime.valueOf(),
                bankReference: 'JSAVE111',
                savedAmount: '100000::HUNDREDTH_CENT::USD',
                logContext: expectedLogContext
            }
        };

        const expectedAdminSettledLog = {
            initiator: testUserId,
            context: expectedLogContext
        };

        const expectedAccountLog = {
            transactionId: testTxId,
            adminUserId: testUserId,
            logType: 'ADMIN_SETTLED_SAVE',
            logContext: {
                settleInstruction: {
                    transactionId: testTxId,
                    paymentRef: 'Saving event completed',
                    paymentProvider: 'ADMIN_OVERRIDE',
                    settlingUserId: testUserId
                },
                resultPayload: {
                    transactionDetails: [{ 'accountTransactionType': 'USER_SAVING_EVENT' }]
                }
            }
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
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify({result: 'SUCCESS', updateLog: { transactionDetails: [{ accountTransactionType: 'USER_SAVING_EVENT' }]}})
        };

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            transactionId: testTxId,
            fieldToUpdate: 'TRANSACTION',
            newTxStatus: 'SETTLED',
            reasonToLog: 'Saving event completed'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
        expect(publishEventStub).to.have.been.calledTwice;
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'SAVING_PAYMENT_SUCCESSFUL', expectedSaveSettledLog);
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'ADMIN_SETTLED_SAVE', expectedAdminSettledLog);
        expect(insertAccountLogStub).to.have.been.calledOnceWithExactly(expectedAccountLog);
    });

    it('Adjusts amount on user transactions', async () => {

        const mockTx = { 
            accountId: testAccountId,
            transactionType: 'USER_SAVING_EVENT', 
            settlementStatus: 'PENDING', 
            humanReference: 'JSAVE111', 
            amount: 5000, 
            unit: 'HUNDREDTH_CENT', 
            currency: 'USD' 
        };
        
        fetchTxDetailsStub.resolves(mockTx);

        publishEventStub.resolves({ result: 'SUCCESS' });
        insertAccountLogStub.resolves({ creationTime: testCreationTime });
        
        const testLogTime = moment();
        momentStub.returns(testLogTime);

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            transactionId: testTxId,
            fieldToUpdate: 'TRANSACTION',
            newAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            reasonToLog: 'Saving event completed, at different EFT amount'
        };

        const testEvent = helper.wrapEvent(requestBody, testAdminId, 'SYSTEM_ADMIN');

        adjustTxAmountStub.resolves({ updatedTime: testLogTime.format(), ...requestBody.newAmount });

        const resultOfUpdate = await handler.manageUser(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfUpdate, true);
        
        const expectedResult = { result: 'SUCCESS', updateLog: { updatedTime: testLogTime.format(), ...requestBody.newAmount }};
        expect(resultBody).to.deep.equal(expectedResult);

        expect(fetchTxDetailsStub).to.have.been.calledOnceWithExactly(testTxId);
        expect(adjustTxAmountStub).to.have.been.calledOnceWithExactly({
            transactionId: testTxId,
            newAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        });

        const expectedUserEventLogOptions = {
            initiator: testAdminId,
            timestamp: testLogTime.valueOf(),
            context: {
                transactionId: testTxId,
                accountId: testAccountId,
                transactionType: 'USER_SAVING_EVENT',
                transactionStatus: 'PENDING',
                humanReference: 'JSAVE111',
                timeInMillis: testLogTime.valueOf(),
                oldAmount: { amount: 5000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                newAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                reason: 'Saving event completed, at different EFT amount'
            }
        };

        const expectedAccountLog = {
            transactionId: testTxId,
            accountId: testAccountId,
            adminUserId: testAdminId,
            logType: 'ADMIN_UPDATED_TX',
            logContext: {
                reason: 'Saving event completed, at different EFT amount',
                oldAmount: { amount: 5000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                newAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' }
            }
        };

        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'ADMIN_UPDATED_TX', expectedUserEventLogOptions);
        expect(insertAccountLogStub).to.have.been.calledOnceWithExactly(expectedAccountLog);
    });

    it('Initiates a transaction (via lambda)', async () => {
        const testRequestBody = {
            systemWideUserId: testUserId,
            fieldToUpdate: 'TRANSACTION',
            operation: 'INITIATE',
            parameters: {
                accountId: testAccountId,
                amount: 1000000,
                unit: 'HUNDREDTH_CENT',
                currency: 'USD',
                transactionType: 'USER_SAVING_EVENT'
            },
            reasonToLog: 'Manual EFT sent in'
        };

        const mockSaveResult = {
            transactionDetails: [{ accountTransactionId: uuid(), creationTimeEpochMillis: moment().valueOf() }],
            humanReference: 'JSAVE101',
            bankDetails: {}
        };
        const mockPayload = JSON.stringify({ statusCode: 200, body: JSON.stringify(mockSaveResult) });

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 200, Payload: mockPayload })});

        const testEvent = helper.wrapEvent(testRequestBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update: ', resultOfUpdate);

        const resultBody = helper.standardOkayChecks(resultOfUpdate);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', saveDetails: mockSaveResult });

        const expectedInvokeBody = { accountId: testAccountId, amount: 1000000, unit: 'HUNDREDTH_CENT', currency: 'USD' };
        const expectedInvokeEvent = { requestContext: testEvent.requestContext, body: stringify(expectedInvokeBody) };
        const expectedInvocation = helper.wrapLambdaInvoc('save_initiate', false, expectedInvokeEvent);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Handles pending transactions', async () => {

        const mockLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                transactionDetails: [
                    { transactionType: 'USER_SAVING_EVENT' }
                ]
            })
        };

        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });
        publishEventStub.resolves({ result: 'SUCCESS' });
        adjustTxStatusStub.resolves({ settlementStatus: 'PENDING', updatedTime: testUpdatedTime });

        const expectedPublishArgs = {
            initiator: testUserId,
            context: {
                newStatus: 'PENDING',
                owningUserId: testUserId,
                performedBy: testUserId,
                reason: 'Saving event pending',
                transactionId: testTxId
            }
        };

        const expectedLog = {
            transactionId: testTxId,
            adminUserId: testUserId,
            logType: 'ADMIN_UPDATED_TX',
            logContext: {
                performedBy: testUserId,
                owningUserId: testUserId,
                reason: 'Saving event pending',
                newStatus: 'PENDING'
            }
        };

        const expectedResult = {
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify({result: 'SUCCESS', updateLog: { settlementStatus: 'PENDING', updatedTime: testUpdatedTime }})
        };

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            transactionId: testTxId,
            fieldToUpdate: 'TRANSACTION',
            newTxStatus: 'PENDING',
            reasonToLog: 'Saving event pending'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'ADMIN_UPDATED_TX', expectedPublishArgs);
        expect(insertAccountLogStub).to.have.been.calledOnceWithExactly(expectedLog);
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('User transaction status update fails on invalid parameters', async () => {
    
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
            body: JSON.stringify('Error, invalid transaction status')
        };

        const requiredProperties = ['transactionId', 'newTxStatus'];
        requiredProperties.forEach(async (property) => {
            const params = { ...requestBody };
            Reflect.deleteProperty(params, property);
            await expect(handler.manageUser(helper.wrapEvent(params, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);
        });

        const params = { ...requestBody };
        params.newTxStatus = 'INVALID_STATUS';
        await expect(handler.manageUser(helper.wrapEvent(params, testUserId, 'SYSTEM_ADMIN'))).to.eventually.deep.equal(expectedResult);

        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;

    });

});

describe('*** UNIT TEST USER STATUS MGMT', async () => {

    beforeEach(() => helper.resetStubs(fetchTxDetailsStub, lamdbaInvokeStub, publishEventStub, insertAccountLogStub, updateBsheetTagStub, fetchBsheetTagStub));

    it('Updates user kyc status', async () => {

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({result: 'SUCCESS'}, 200) });

        const expectedResult = {
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify({ result: 'SUCCESS', updateLog: { result: 'SUCCESS' }})
        };

        const expectedInvocation = {
            FunctionName: config.get('lambdas.statusUpdate'),
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                initiator: testUserId,
                systemWideUserId: testUserId,
                updatedKycStatus: {
                    changeTo: 'CONTACT_VERIFIED',
                    reasonToLog: 'User contact verified'
                }
            })
        };

        const requestBody = {
            systemWideUserId: testUserId,
            fieldToUpdate: 'KYC',
            newStatus: 'CONTACT_VERIFIED',
            reasonToLog: 'User contact verified'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
    });

    it('Updated user status', async () => {
        
        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse({result: 'SUCCESS'}, 200) });

        const expectedResult = {
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify({ result: 'SUCCESS', updateLog: { result: 'SUCCESS' }})
        };

        const expectedInvocation = {
            FunctionName: 'profile_status_update',
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                initiator: testUserId,
                systemWideUserId: testUserId,
                updatedUserStatus: {
                    changeTo: 'ACCOUNT_OPENED',
                    reasonToLog: 'User account opened'
                }
            })
        };

        const requestBody = {
            systemWideUserId: testUserId,
            fieldToUpdate: 'STATUS',
            newStatus: 'ACCOUNT_OPENED',
            reasonToLog: 'User account opened'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
    });

    it('Updates user balance sheet', async () => {

        updateBsheetTagStub.resolves({ ownerUserId: testUserId, tags: ['FINWORKS::NEW_IDENTIFIER'], oldItendifier: 'OLD_IDENTIFIER'});
        publishEventStub.resolves({ result: 'SUCCESS' });
        insertAccountLogStub.resolves({ creationTime: testCreationTime });

        const expectedResult = {
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify({
                result: 'SUCCESS',
                updateLog: {
                    ownerUserId: testUserId,
                    tags: ['FINWORKS::NEW_IDENTIFIER'],
                    oldItendifier: 'OLD_IDENTIFIER'
                }
            })
        };

        const expectedLog = {
            accountId: testAccountId,
            adminUserId: testUserId,
            logType: 'ADMIN_UPDATED_BSHEET_TAG',
            logContext: {
                performedBy: testUserId,
                owningUserId: testUserId,
                newIdentifier: 'NEW_IDENTIFIER',
                oldIdentifier: undefined
            }
        };

        const expectedPublishArgs = {
            initiator: testUserId,
            context: {
                performedBy: testUserId,
                owningUserId: testUserId,
                newIdentifier: 'NEW_IDENTIFIER',
                oldIdentifier: undefined,
                accountId: testAccountId
            }
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
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'ADMIN_UPDATED_BSHEET_TAG', expectedPublishArgs);
        expect(insertAccountLogStub).to.have.been.calledOnceWithExactly(expectedLog);
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

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
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
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

        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
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

        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;

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

        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;

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
        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;

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
        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;

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
        expect(updateBsheetTagStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
        expect(insertAccountLogStub).to.have.not.been.called;
    });

});
