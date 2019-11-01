'use strict';

const logger = require('debug')('jupiter:admin:user-handler-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const momentStub = sinon.stub();
const findAccountStub = sinon.stub();
const fetchPriorTxStub = sinon.stub()
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../history-handler', {
    './persistence/rds': {
        'findAccountsForUser': findAccountStub,
        'fetchPriorTransactions': fetchPriorTxStub
    },
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

describe.only('*** UNIT TEST ADMIN USER HANDLER ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();
    const testPhone = '+276323503434';
    const testNationalId = '931223493933434';
    const testTime = moment();

    const wrapLambdaInvoc = (functionName, async, payload) => ({
        FunctionName: functionName,
        InvocationType: async ? 'Event' : 'RequestResponse',
        Payload: JSON.stringify(payload)
    });
    
    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    const expectedTxResponse = {
        transactionId: uuid(),
        accountId: uuid(),
        creationTime: moment().format(),
        transactionType: 'ALLOCATION',
        settlementStatus: 'SETTLED',
        amount: '100',
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        humanReference: 'BUSANI6'
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

    const testBalance = () => ({
        amount: Math.trunc(Math.floor(Math.random() * (6000000 - 5000000) + 5000000)),
        unit: 'HUNDREDTH_CENT',
        currency: 'USD',
        datetime: moment().format(),
        epochMilli: moment().valueOf(),
        timezone: 'America/New_York'
    });

    const expectedBalance = {
        accountId: [ testAccountId ],
        balanceStartDayOrLastSettled: testBalance(),
        balanceEndOfToday: testBalance(),
        currentBalance: testBalance(),
        balanceSubsequentDays: [ testBalance(), testBalance(), testBalance() ]
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
                    timestamp: moment().subtract(5, 'days').valueOf(),
                    userId: testUserId,
                    eventType: 'REGISTERED'
                },
                {
                    initiator: 'SYSTEM',
                    context: JSON.stringify({ freeForm: 'JSON object' }),
                    interface: 'MOBILE_APP',
                    timestamp: moment().subtract(4, 'days').valueOf(),
                    userId: testUserId,
                    eventType: 'PASSWORD_SET'
                },
                {
                    initiator: 'SYSTEM',
                    context: JSON.stringify({ freeForm: 'JSON object' }),
                    interface: 'MOBILE_APP',
                    timestamp: moment().subtract(2, 'days').valueOf(),
                    userId: testUserId,
                    eventType: 'USER_LOGIN'
                }]
            }
        })
    };

    beforeEach(() => {
        helper.resetStubs(momentStub, findAccountStub, fetchPriorTxStub, lamdbaInvokeStub);
    });

    it.only('Fetches user balance, accrued interest, previous user transactions, and major user events', async () => {

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

        lamdbaInvokeStub.withArgs(wrapLambdaInvoc(config.get('lambdas.systemWideIdLookup'), false, { nationalId: testNationalId })).returns({ 
            promise: () => mockLambdaResponse({ systemWideUserId: testUserId })
        });

        lamdbaInvokeStub.withArgs(wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId })).returns({
            promise: () => mockLambdaResponse(expectedProfile)
        });

        lamdbaInvokeStub.withArgs(wrapLambdaInvoc(config.get('lambdas.userHistory'), false, testHistoryEvent)).returns({
            promise: () => expectedHistory
        });

        lamdbaInvokeStub.withArgs(wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), false, testBalancePayload)).returns({
            promise: () => mockLambdaResponse(expectedBalance)
        });

        findAccountStub.withArgs(testUserId).resolves([testAccountId]);

        fetchPriorTxStub.withArgs(testAccountId).resolves([expectedTxResponse])

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

        const result = await handler.fetchUserHistory(testEvent);
        logger('Result of user look up:', result);
    });

    it('Fails on unauthorized access', async () => {
        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            httpMethod: 'GET',
            queryStringParameters: {
                nationalId: testNationalId
            }
        };

        const result = await handler.fetchUserHistory(testEvent);
        logger('Result of user look up:', result);
    });

    it('Catches thrown errors', async () => {
        lamdbaInvokeStub.throws(new Error('ERROR'));

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

        const result = await handler.fetchUserHistory(testEvent);
        logger('Result of user look up:', result);
    });
});
