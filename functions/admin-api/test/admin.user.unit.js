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

const MAX_AMOUNT = 6000000;
const MIN_AMOUNT = 5000000;

const momentStub = sinon.stub();
const pendingTxStub = sinon.stub();
const countUsersStub = sinon.stub();
const publishEventStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const adjustTxStatusStub = sinon.stub();
const fetchBsheetTagStub = sinon.stub();
const updateBsheetTagStub = sinon.stub();
const insertAccountLogStub = sinon.stub();
const fetchTxDetailsStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-user-handler', {
    './persistence/rds.account': {
        'fetchBsheetTag': fetchBsheetTagStub,
        'adjustTxStatus': adjustTxStatusStub,
        'updateBsheetTag': updateBsheetTagStub,
        'insertAccountLog': insertAccountLogStub,
        'fetchUserPendingTransactions': pendingTxStub,
        'getTransactionDetails': fetchTxDetailsStub,
        '@noCallThru': true
    },
    'publish-common': {
        publishUserEvent: publishEventStub
    },
    './admin.util': {},
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

describe('*** UNIT TEST ADMIN USER HANDLER ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();

    const testPhone = '27820234324';
    const testNationalId = '03122893249435034';

    const startDay = 5;
    const interval = 1;

    const testTime = moment();

    const expectedTxResponse = {
        transactionId: uuid(),
        accountId: uuid(),
        creationTime: moment().format(),
        transactionType: 'ALLOCATION',
        settlementStatus: 'SETTLED',
        amount: '100',
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        humanReference: 'BUSANI1'
    };

    const expectedProfile = {
        systemWideUserId: testUserId,
        clientId: 'some_client_co',
        defaultFloatId: 'some_float',
        defaultCurrency: 'USD',
        defaultTimezone: 'America/New_York',
        nationalId: 'some_national_id_here',
        primaryPhone: testPhone,
        userStatus: 'USER_HAS_SAVED',
        kycStatus: 'VERIFIED_AS_PERSON',
        kycRiskRating: 0,
        securedStatus: 'PASSWORD_SET',
        userRole: 'ORDINARY_USER',
        tags: 'GRANTED_GIFT'
    };

    const generateAmount = () => {
        const base = Math.floor(Math.random());
        const multiplier = (MAX_AMOUNT - MIN_AMOUNT);
        const normalizer = MIN_AMOUNT;
        const rawResult = base * multiplier;
        return rawResult + normalizer;
    };

    const testBalance = () => ({
        amount: generateAmount(),
        unit: 'HUNDREDTH_CENT',
        currency: 'USD',
        datetime: moment().format(),
        epochMilli: moment().valueOf(),
        timezone: 'America/New_York'
    });

    const expectedBalance = {
        accountId: [testAccountId],
        balanceStartDayOrLastSettled: testBalance(),
        balanceEndOfToday: testBalance(),
        currentBalance: testBalance(),
        balanceSubsequentDays: [testBalance(), testBalance(), testBalance()]
    };

    const expectedHistory = {
        StatusCode: 200,
        Payload: JSON.stringify({
            result: 'success',
            userEvents: {
                totalCount: 12,
                userEvents: [{
                    initiator: 'SYSTEM',
                    context: JSON.stringify({ freeForm: 'JSON object' }),
                    interface: 'MOBILE_APP',
                    timestamp: moment().subtract(startDay, 'days').valueOf(),
                    userId: testUserId,
                    eventType: 'REGISTERED'
                },
                {
                    initiator: 'SYSTEM',
                    context: JSON.stringify({ freeForm: 'JSON object' }),
                    interface: 'MOBILE_APP',
                    timestamp: moment().subtract(startDay - interval, 'days').valueOf(),
                    userId: testUserId,
                    eventType: 'PASSWORD_SET'
                },
                {
                    initiator: 'SYSTEM',
                    context: JSON.stringify({ freeForm: 'JSON object' }),
                    interface: 'MOBILE_APP',
                    timestamp: moment().subtract(startDay - interval - interval, 'days').valueOf(),
                    userId: testUserId,
                    eventType: 'USER_LOGIN'
                }]
            }
        })
    };

    it('Looks up user', async () => {

        const testHistoryEvent = {
            userId: testUserId,
            eventTypes: config.get('defaults.userHistory.eventTypes'),
            startDate: testTime.valueOf(),
            endDate: testTime.valueOf()
        };

        const testBalancePayload = {
            userId: expectedProfile.systemWideUserId,
            currency: expectedProfile.defaultCurrency,
            atEpochMillis: testTime.valueOf(),
            timezone: expectedProfile.defaultTimezone, 
            clientId: expectedProfile.clientId,
            daysToProject: 0
        };

        momentStub.returns({
            valueOf: () => testTime.valueOf(),
            subtract: () => testTime
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.systemWideIdLookup'), false, { nationalId: testNationalId })).returns({ 
            promise: () => helper.mockLambdaResponse({ systemWideUserId: testUserId })
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId })).returns({
            promise: () => helper.mockLambdaResponse(expectedProfile)
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, testHistoryEvent)).returns({
            promise: () => expectedHistory
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), false, testBalancePayload)).returns({
            promise: () => helper.mockLambdaResponse(expectedBalance)
        });

        pendingTxStub.withArgs(testUserId, sinon.match.any).resolves(expectedTxResponse);
        fetchBsheetTagStub.resolves('TUSER1234');

        const expectedResult = {
            ...expectedProfile,
            userBalance: { ...expectedBalance, bsheetIdentifier: 'TUSER1234' },
            pendingTransactions: expectedTxResponse,
            userHistory: JSON.parse(expectedHistory.Payload).userEvents
        };

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            httpMethod: 'GET',
            queryStringParameters: {
                nationalId: testNationalId
            }
        };

        const result = await handler.lookUpUser(testEvent);
        logger('Result of user look up:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 200);
        expect(result.headers).to.deep.equal(helper.expectedHeaders);
        expect(result.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.systemWideIdLookup'), false, { nationalId: testNationalId }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), false, testBalancePayload));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, testHistoryEvent));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(pendingTxStub).to.have.been.calledWith(testUserId, sinon.match.any);
    });
});


describe('*** UNIT TEST USER COUNT ***', () => {
    
    const testUserId = uuid();
    const MAX_USERS = 10000000;
    const MIN_USERS = 9000000;
    
    const generateUserCount = () => {
        const base = Math.floor(Math.random());
        const multiplier = MAX_USERS - MIN_USERS;
        const normalizer = MIN_USERS;
        const rawResult = base * multiplier;
        return rawResult + normalizer;
    };

    const adminHandler = proxyquire('../admin-user-handler', {
        './persistence/rds.account': {
            'countUserIdsWithAccounts': countUsersStub
        },
        './admin.util': {},
        'aws-sdk': {
            'Lambda': MockLambdaClient  
        }
    });

    it('Fetches user count', async () => {
        const testUserCount = generateUserCount;

        countUsersStub.resolves(testUserCount);

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            httpMethod: 'GET',
            queryStringParameters: {
                includeNewButNoSave: true
            }
        };

        const userCount = await adminHandler.fetchUserCounts(testEvent);
        logger('Result of user count:', userCount);

        expect(userCount).to.exist;
        expect(userCount).to.have.property('statusCode', 200);
        expect(userCount.headers).to.deep.equal(helper.expectedHeaders);
        expect(userCount.body).to.deep.equal(JSON.stringify({ userCount: testUserCount }));
        expect(countUsersStub).to.have.been.calledOnce;
    });
    
});

describe('*** UNIT TEST USER MANAGEMENT ***', () => {
    const testAccountId = uuid();
    const testAdminId = uuid();
    const testUserId = uuid();
    const testTxId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    beforeEach(() => helper.resetStubs(lamdbaInvokeStub, publishEventStub, insertAccountLogStub, updateBsheetTagStub, fetchBsheetTagStub));

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
            options: {
                context: {
                    transactionId: testTxId,
                    accountId: testAccountId,
                    timeInMillis: testLogTime.valueOf(),
                    bankReference: 'JSAVE111',
                    savedAmount: '100000::HUNDREDTH_CENT::USD',
                    logContext: expectedLogContext
                }
            }
        };

        const expectedAdminSettledLog = {
            initiator: testUserId,
            options: {
                context: expectedLogContext
            }
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
            options: {
                context: {
                    newStatus: 'PENDING',
                    owningUserId: testUserId,
                    performedBy: testUserId,
                    reason: 'Saving event pending',
                    transactionId: testTxId
                }
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
            options: {
                context: {
                    performedBy: testUserId,
                    owningUserId: testUserId,
                    newIdentifier: 'NEW_IDENTIFIER',
                    oldIdentifier: undefined,
                    accountId: testAccountId
                }
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
            body: JSON.stringify('Error, transaction ID needed and valid transaction status')
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
