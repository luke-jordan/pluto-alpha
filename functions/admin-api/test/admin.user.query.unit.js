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
const lamdbaInvokeStub = sinon.stub();
const fetchBsheetTagStub = sinon.stub();
const fetchTxDetailsStub = sinon.stub();
const listUserAccountsStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-user-query', {
    './persistence/rds.account': {
        'fetchBsheetTag': fetchBsheetTagStub,
        'fetchUserPendingTransactions': pendingTxStub,
        'getTransactionDetails': fetchTxDetailsStub,
        'countUserIdsWithAccounts': countUsersStub,
        'listAccounts': listUserAccountsStub,
        '@noCallThru': true
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

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true })).returns({
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

        const result = await handler.findUsers(testEvent);
        logger('Result of user look up:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 200);
        expect(result.headers).to.deep.equal(helper.expectedHeaders);
        expect(result.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.systemWideIdLookup'), false, { nationalId: testNationalId }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), false, testBalancePayload));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, testHistoryEvent));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true }));
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

    beforeEach(() => helper.resetStubs(momentStub));

    it('Fetches user count', async () => {
        const testUserCount = generateUserCount;

        momentStub.returns(moment());
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

        const userCount = await handler.fetchUserCounts(testEvent);
        logger('Result of user count:', userCount);

        expect(userCount).to.exist;
        expect(userCount).to.have.property('statusCode', 200);
        expect(userCount.headers).to.deep.equal(helper.expectedHeaders);
        expect(userCount.body).to.deep.equal(JSON.stringify({ userCount: testUserCount }));
        expect(countUsersStub).to.have.been.calledOnce;
    });

    it('Fetches list of current user accounts', async () => {
        const testTime = moment().subtract(1, 'month');
        const testTimeFormat = testTime.format();
        const testTimeValue = testTime.valueOf();

        const testEvent = {
            requestContext: {
                authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testUserId }
            },
            httpMethod: 'GET',
            queryStringParameters: {
                type: 'list'
            }
        };


        const mockUserList = [{ accountId: 'someaccount', humanRef: 'something', creationTime: testTimeFormat }];
        const expectedUserList = [{ accountId: 'someaccount', humanRef: 'something', creationTime: testTimeValue }];

        listUserAccountsStub.resolves(mockUserList);
        momentStub.withArgs(testTimeFormat).returns({ valueOf: () => testTimeValue });

        const userList = await handler.findUsers(testEvent);
        const userListBody = helper.standardOkayChecks(userList);

        expect(userListBody).to.deep.equal(expectedUserList);

        expect(listUserAccountsStub).to.have.been.calledOnceWithExactly();
    });

    it('Rejects with error unauthorized call to list events', async () => {
        const testEvent = {
            requestContext: {
                authorizer: { role: 'ORDINARY_USER', systemWideUserId: testUserId }
            },
            httpMethod: 'GET',
            queryStringParameters: {
                type: 'list'
            }
        };

        const userList = await handler.findUsers(testEvent);
        expect(userList).to.deep.equal({ statusCode: 403, headers: helper.expectedHeaders });
    });
    
});