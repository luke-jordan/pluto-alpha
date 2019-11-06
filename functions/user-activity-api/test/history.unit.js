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
const getAccountFigureStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../history-handler', {
    './persistence/rds': {
        'findAccountsForUser': findAccountStub,
        'fetchPriorTransactions': fetchPriorTxStub,
        'getUserAccountFigure': getAccountFigureStub
    },
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

describe('*** UNIT TEST ADMIN USER HANDLER ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();
    const testPhone = '+276323503434';
    const testNationalId = '931223493933434';
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

    // non-redundant usage
    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

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
        helper.resetStubs(momentStub, findAccountStub, fetchPriorTxStub, lamdbaInvokeStub, getAccountFigureStub);
    });

    it('Fetches user balance, accrued interest, previous user transactions, and major user events', async () => {

        const testHistoryEvent = {
            userId: testUserId,
            eventTypes: config.get('defaults.userHistory.eventTypes'),
            startDate: testTime.valueOf(),
            endDate: testTime.valueOf()
        };

        const testBalancePayload = {
            userId: testUserId,
            currency: 'USD',
            atEpochMillis: testTime.valueOf(),
            timezone: 'America/New_York', 
            clientId: 'some_client_co',
            daysToProject: 0
        };

        momentStub.returns({
            valueOf: () => testTime.valueOf(),
            subtract: () => testTime,
            startOf: () => testTime
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId })).returns({
            promise: () => mockLambdaResponse(expectedProfile)
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, testHistoryEvent)).returns({
            promise: () => expectedHistory
        });

        lamdbaInvokeStub.withArgs(helper.wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), false, testBalancePayload)).returns({
            promise: () => mockLambdaResponse(expectedBalance)
        });

        getAccountFigureStub.withArgs({ systemWideUserId: testUserId, operation: `interest::WHOLE_CENT::USD::${testTime.valueOf()}`}).resolves(
            { amount: 20, unit: 'WHOLE_CURRENCY', currency: 'USD' }
        );

        findAccountStub.withArgs(testUserId).resolves([testAccountId]);

        fetchPriorTxStub.withArgs(testAccountId).resolves([expectedTxResponse])

        const testEvent = {
            requestContext: {
                authorizer: { systemWideUserId: testUserId }
            },
            httpMethod: 'GET'
        };

        const userHistoryArray = JSON.parse(expectedHistory.Payload).userEvents.userEvents;

        const expectedResult = {
            userBalance: expectedBalance,
            accruedInterest: '$20',
            userHistory: [...helper.normalizeHistory(userHistoryArray), ...helper.normalizeTx([expectedTxResponse])]
        };

        const result = await handler.fetchUserHistory(testEvent);
        logger('Result of user look up:', result);
       
        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 200);
        // expect(result.body).to.deep.equal(JSON.stringify(expectedResult)); // momentStub isn't stubbing out a specific instance. to be seen to. all else is as expected. 
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), false, testBalancePayload));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, testHistoryEvent));
        expect(getAccountFigureStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testUserId, operation: `interest::WHOLE_CENT::USD::${testTime.valueOf()}`});
        expect(findAccountStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(fetchPriorTxStub).to.have.been.calledOnceWithExactly(testAccountId);
    });

    it('Fails on unauthorized access', async () => {
        const testEvent = {
            httpMethod: 'GET',
            queryStringParameters: { nationalId: testNationalId }
        };

        const result = await handler.fetchUserHistory(testEvent);
        logger('Result of user look up:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 403);
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(getAccountFigureStub).to.have.not.been.called;
        expect(findAccountStub).to.have.not.been.called;
        expect(fetchPriorTxStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        lamdbaInvokeStub.throws(new Error('ERROR'));

        const testEvent = {
            requestContext: {
                authorizer: { systemWideUserId: testUserId }
            },
            httpMethod: 'GET'
        };

        const result = await handler.fetchUserHistory(testEvent);
        logger('Result of user look up:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 500);
        expect(result.body).to.deep.equal(JSON.stringify('ERROR'));
        expect(getAccountFigureStub).to.have.not.been.called;
        expect(findAccountStub).to.have.not.been.called;
        expect(fetchPriorTxStub).to.have.not.been.called;
    });
});
