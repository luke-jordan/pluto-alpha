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
const lamdbaInvokeStub = sinon.stub();
const adjustTxStatusStub = sinon.stub();
const adjustTxAmountStub = sinon.stub();
const fetchBsheetTagStub = sinon.stub();
const updateBsheetTagStub = sinon.stub();
const insertAccountLogStub = sinon.stub();
const fetchTxDetailsStub = sinon.stub();
const countSettledTxStub = sinon.stub();

const getAccountDetailsStub = sinon.stub();
const updateAccountFlagsStub = sinon.stub();

const publishEventStub = sinon.stub();
const sendSystemEmailStub = sinon.stub();
const sendSmsStub = sinon.stub();

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
        'countTransactionsBySameAccount': countSettledTxStub,
        'getAccountDetails': getAccountDetailsStub,
        'updateAccountFlags': updateAccountFlagsStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishEventStub,
        'sendSystemEmail': sendSystemEmailStub,
        'sendSms': sendSmsStub,
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

    beforeEach(() => helper.resetStubs(
        fetchTxDetailsStub, lamdbaInvokeStub, publishEventStub, insertAccountLogStub, 
        updateBsheetTagStub, fetchBsheetTagStub, countSettledTxStub
    ));

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
        fetchTxDetailsStub.resolves({ accountId: testAccountId, humanReference: 'JSAVE111', amount: 100000, unit: 'HUNDREDTH_CENT', currency: 'USD', tags: [] });
        countSettledTxStub.resolves(1);

        const expectedAdminLogContext = {
            timeInMillis: sinon.match.number, // slightly redundant but used elsewhere
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
                timeInMillis: sinon.match.number,
                bankReference: 'JSAVE111',
                savedAmount: '100000::HUNDREDTH_CENT::USD',
                saveCount: 1,
                firstSave: true,
                transactionTags: [],
                logContext: expectedAdminLogContext
            }
        };

        const expectedAdminSettledLog = {
            initiator: testUserId,
            context: expectedAdminLogContext
        };

        const expectedAccountLog = {
            transactionId: testTxId,
            adminUserId: testUserId,
            logType: 'ADMIN_SETTLED_SAVE',
            logContext: {
                timeInMillis: sinon.match.number, // slightly redundant but minimal loss and makes other processing simpler
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
            timestamp: sinon.match.number, // else need to pass moment stub all the way through, for little gain (bring back when split tests)
            context: {
                transactionId: testTxId,
                accountId: testAccountId,
                transactionType: 'USER_SAVING_EVENT',
                transactionStatus: 'PENDING',
                humanReference: 'JSAVE111',
                timeInMillis: sinon.match.number,
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

    it('Initiates a save (via lambda)', async () => {
        const testRequestBody = {
            systemWideUserId: testUserId,
            fieldToUpdate: 'TRANSACTION',
            operation: 'INITIATE',
            transactionParameters: {
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

        const expectedInvokeBody = { accountId: testAccountId, amount: 1000000, unit: 'HUNDREDTH_CENT', currency: 'USD', systemWideUserId: testUserId };
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

        helper.expectNoCalls(updateBsheetTagStub, publishEventStub, insertAccountLogStub, lamdbaInvokeStub);
    });

    it('Updates user password, email route', async () => {
        const pwdInvocationResult = helper.mockLambdaResponse({ newPassword: 'DANCING_TIGER_1123' }, 200);
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => pwdInvocationResult });

        const profileInvocationResult = helper.mockLambdaResponse({ emailAddress: 'example@email.com' }, 200);
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => profileInvocationResult });

        sendSystemEmailStub.resolves({ result: 'SUCCESS' });
       
        const requestBody = {
            adminUserId: testAdminId,
            accountId: testAccountId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'PWORD',
            reasonToLog: 'Updating user password'
        };

        const testEvent = helper.wrapEvent(requestBody, testAdminId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfUpdate);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updateLog: { dispatchResult: { result: 'SUCCESS' }}});

        const expectedPwdPayload = {
            generateRandom: true,
            systemWideUserId: testUserId,
            requestContext: {
                authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testAdminId }
            }
        };
        const expectedPwdInvocation = helper.wrapLambdaInvoc('password_update', false, expectedPwdPayload);

        const expectedProfilePayload = { systemWideUserId: testUserId, includeContactMethod: true };
        const expectedProfileInvocation = helper.wrapLambdaInvoc('profile_fetch', false, expectedProfilePayload);

        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedPwdInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedProfileInvocation);

        const expectedEmailParams = {
            subject: 'Jupiter Password',
            toList: ['example@email.com'],
            bodyTemplateKey: config.get('email.pwdReset.templateKey'),
            templateVariables: { pwd: 'DANCING_TIGER_1123' }
        };

        expect(sendSystemEmailStub).to.have.been.calledOnceWithExactly(expectedEmailParams);
    });

    it('Updates user password, sms route', async () => {
        const pwdInvocationResult = helper.mockLambdaResponse({ newPassword: 'NOBLE_PASSPHRASE_5813' }, 200);
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => pwdInvocationResult });

        const profileInvocationResult = helper.mockLambdaResponse({ phoneNumber: '278162726373' }, 200);
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => profileInvocationResult });
       
        sendSmsStub.resolves({ result: 'SUCCESS' });

        const requestBody = {
            adminUserId: testAdminId,
            accountId: testAccountId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'PWORD',
            reasonToLog: 'Updating user password'
        };

        const testEvent = helper.wrapEvent(requestBody, testAdminId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfUpdate);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updateLog: { dispatchResult: { result: 'SUCCESS' }}});

        const expectedPwdPayload = {
            generateRandom: true,
            systemWideUserId: testUserId,
            requestContext: {
                authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testAdminId }
            }
        };

        const expectedPwdInvocation = helper.wrapLambdaInvoc('password_update', false, expectedPwdPayload);

        const expectedProfilePayload = { systemWideUserId: testUserId, includeContactMethod: true };
        const expectedProfileInvocation = helper.wrapLambdaInvoc('profile_fetch', false, expectedProfilePayload);

        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedPwdInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedProfileInvocation);

        const expectedMsg = `Your password has been successfully reset. Please use the following ` +
            `password to login to your account: NOBLE_PASSPHRASE_5813. Please create a new password once logged in.`;
        const expectedSMSParams = { phoneNumber: '+278162726373', message: expectedMsg };
        expect(sendSmsStub).to.have.been.calledOnceWithExactly(expectedSMSParams);
    });

    it('Updates user flags', async () => {
        getAccountDetailsStub.resolves({ accountId: testAccountId, flags: ['TEST::OLD::FLAG'] });
        updateAccountFlagsStub.resolves(moment(testUpdatedTime));

        const requestBody = {
            adminUserId: testAdminId,
            accountId: testAccountId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'FLAGS',
            flags: ['TEST::NEW::FLAG'],
            reasonToLog: 'Updating user flags'
        };

        const testEvent = helper.wrapEvent(requestBody, testAdminId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfUpdate);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });

        expect(getAccountDetailsStub).to.have.been.calledOnceWithExactly(testUserId);

        const expectedUpdateParams = {
            accountId: testAccountId,
            adminUserId: testAdminId,
            newFlags: ['TEST::NEW::FLAG'],
            oldFlags: ['TEST::OLD::FLAG']
        };

        expect(updateAccountFlagsStub).to.have.been.calledOnceWithExactly(expectedUpdateParams);
    });

    // it('Updates log records', async () => {

    // });

    // it('Updates user message preferences', async () => {

    // });

});

describe('*** UNIT TEST USER STATUS MGMT', async () => {

    beforeEach(() => helper.resetStubs(fetchTxDetailsStub, lamdbaInvokeStub, publishEventStub, insertAccountLogStub, updateBsheetTagStub, fetchBsheetTagStub));

    it('Updates user kyc status, and publishes log', async () => {

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
                initiator: testAdminId,
                systemWideUserId: testUserId,
                updatedKycStatus: {
                    changeTo: 'VERIFIED_AS_PERSON',
                    reasonToLog: 'User contact verified'
                }
            })
        };

        const expectedLogOptions = {
            initiator: testAdminId,
            context: { reasonToLog: 'User contact verified' } 
        };

        const requestBody = {
            systemWideUserId: testUserId,
            fieldToUpdate: 'KYC',
            newStatus: 'VERIFIED_AS_PERSON',
            reasonToLog: 'User contact verified'
        };

        const testEvent = helper.wrapEvent(requestBody, testAdminId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'VERIFIED_AS_PERSON', expectedLogOptions);
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
        helper.expectNoCalls(publishEventStub, insertAccountLogStub);
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

});   
