'use strict';

const logger = require('debug')('jupiter:user-activity-withdrawal:test');
const config = require('config');
const uuid = require('uuid');
const moment = require('moment');

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');

const momentStub = sinon.stub();
const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();
const publishEventStub = sinon.stub();

const countSettledSavesStub = sinon.stub();
const sumAccountBalanceStub = sinon.stub();

const getOwnerInfoForAccountStub = sinon.stub();
const generateBankRefStub = sinon.stub();

const findMostCommonCurrencyStub = sinon.stub();
const fetchFloatVarsForBalanceCalcStub = sinon.stub();

const checkPriorBankVerificationStub = sinon.stub();

const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../withdrawal-handler', {
    'publish-common': {
        'publishUserEvent': publishEventStub,
        '@noCallThru': true
    },
    './persistence/rds': {
        'countSettledSaves': countSettledSavesStub,
        'sumAccountBalance': sumAccountBalanceStub,
        'getOwnerInfoForAccount': getOwnerInfoForAccountStub,
        'findMostCommonCurrency': findMostCommonCurrencyStub,
        '@noCallThru': true
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsForBalanceCalcStub,
        'fetchBankVerificationResult': checkPriorBankVerificationStub,
        '@noCallThru': true
    },
    './payment-link': {
        'generateBankRef': generateBankRefStub
    },
    'ioredis': class {
        constructor () {
            this.get = redisGetStub;
            this.set = redisSetStub;    
        }
    },
    'aws-sdk': { 'Lambda': MockLambdaClient },
    'moment': momentStub
});

describe('*** UNIT TEST WITHDRAWAL BANK SETTING ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();
    const testClientId = uuid();
    const testFloatId = uuid();
    const testNationalId = '91122594738373';
    const testCountryCode = 'ZAF';

    const testBankDetails = {
        bankName: 'ABSA',
        accountNumber: '928392739187391',
        accountType: 'SAVINGS'
    };

    const testUserProfile = {
        systemWideUserId: testUserId,
        creationTimeEpochMillis: moment().valueOf(),
        clientId: testClientId,
        floatId: testFloatId,
        defaultCurrency: 'USD',
        defaultTimezone: 'America/New_York',
        personalName: 'John',
        familyName: 'Doe',
        phoneNumber: '278384748264',
        emailAddress: 'user@email.com',
        countryCode: testCountryCode,
        nationalId: testNationalId,
        userStatus: 'CREATED',
        kycStatus: 'CONTACT_VERIFIED',
        securedStatus: 'PASSWORD_SET',
        updatedTimeEpochMillis: moment().valueOf()
    };

    const mockInterestVars = {
        accrualRateAnnualBps: 750,
        bonusPoolShareOfAccrual: 0.1,
        clientShareOfAccrual: 0.1,
        prudentialFactor: 0
    };

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    beforeEach(() => {
        helper.resetStubs(
            // publishEventStub, redisGetStub, redisSetStub, lamdbaInvokeStub, sumAccountBalanceStub, 
            // updateTxSettlementStatusStub, fetchTransactionStub, countSettledSavesStub, findMostCommonCurrencyStub, 
            // getOwnerInfoForAccountStub, fetchFloatVarsForBalanceCalcStub
        );
    });

    it('Sets withdrawal bank account', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                accountId: testAccountId,
                bankDetails: testBankDetails
            })
        };

        const mockJobIdPayload = {
            operation: 'initialize',
            parameters: {
                bankName: 'ABSA',
                accountNumber: '928392739187391',
                accountType: 'SAVINGS',
                reference: testUserId,
                initials: 'J',
                surname: 'Doe',
                nationalId: testNationalId
            }
        };

        const mockInitializeVerificationResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                status: 'SUCCESS',
                jobId: 'KSDF382'
            })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);

        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        redisSetStub.resolves();

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                availableBalance: { amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null },
                cardTitle: 'Did you know?',
                cardBody: 'Every R100 kept in your Jupiter account earns you at least R6 after a year - hard at work earning for you! If possible, delay or reduce your withdrawal and keep your money earning for you'
            })
        };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, mockJobIdPayload));
        
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify({ ...testBankDetails, verificationJobId: 'KSDF382' }), 'EX', config.get('cache.detailsTTL'));
    });

    it('Fails where user has no savings', async () => {
        const event = helper.wrapEvent({
                accountId: testAccountId,
                bankDetails: testBankDetails,
                clientId: testClientId,
                floatId: testFloatId
        }, testUserId);

        const mockInitializeVerificationResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                status: 'SUCCESS',
                jobId: 'KSDF382'
            })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        countSettledSavesStub.resolves(0);
        findMostCommonCurrencyStub.resolves('ZAR');

        const expectedResult = { statusCode: 400, body: { result: 'USER_HAS_NOT_SAVED' } };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);

        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        helper.expectNoCalls(sumAccountBalanceStub, redisSetStub);
    });

    it('Fails on missing context user id', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, bankDetails: testBankDetails });

        const expectedResult = { statusCode: 403, message: 'User ID not found in context' };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        helper.expectNoCalls(publishEventStub, lamdbaInvokeStub, countSettledSavesStub, findMostCommonCurrencyStub, sumAccountBalanceStub, redisSetStub);
    });

    it('Logs bank verification failure if job ID is not invoked', async () => {
        const event = helper.wrapEvent({
                accountId: testAccountId,
                bankDetails: testBankDetails
        }, testUserId);

        const mockJobIdPayload = {
            operation: 'initialize',
            parameters: {
                bankName: 'ABSA',
                accountNumber: '928392739187391',
                accountType: 'SAVINGS',
                reference: testUserId,
                initials: 'J',
                surname: 'Doe',
                nationalId: testNationalId
            }
        };

        const mockInitializeVerificationResponse = {
            StatusCode: 401,
            Payload: JSON.stringify({ message: 'Internal error' })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        getOwnerInfoForAccountStub.resolves({ clientId: testClientId, floatId: testFloatId });
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });

        const expectedResult = { statusCode: 500, body: JSON.stringify(JSON.stringify({ message: 'Internal error'})) };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, mockJobIdPayload));
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(redisSetStub).to.have.not.been.called;
    });

    it('Records need to do manual job on unsuccessful job id retrieval from third party', async () => {
        const event = helper.wrapEvent({
                accountId: testAccountId,
                bankDetails: testBankDetails,
                clientId: testClientId,
                floatId: testFloatId
        }, testUserId);

        const mockJobIdPayload = {
            operation: 'initialize',
            parameters: {
                bankName: 'ABSA',
                accountNumber: '928392739187391',
                accountType: 'SAVINGS',
                reference: testUserId,
                initials: 'J',
                surname: 'Doe',
                nationalId: testNationalId
            }
        };

        const mockInitializeVerificationResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                status: 'FAILED',
                jobId: 'KSDF382'
            })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                availableBalance: { amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null },
                cardTitle: 'Did you know?',
                cardBody: 'Every R100 kept in your Jupiter account earns you at least R6 after a year - hard at work earning for you! If possible, delay or reduce your withdrawal and keep your money earning for you'
            })
        };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify({
            ...testBankDetails,
            verificationJobId: 'MANUAL_JOB'
        }), 'EX', 900);

        // covered above but leave here to be sure
        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, mockJobIdPayload));
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(getOwnerInfoForAccountStub).to.not.have.been.called;
        
    });

    it('Catches thrown errors', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, bankDetails: testBankDetails }, testUserId);

        publishEventStub.throws(new Error('Internal error'));

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal({ statusCode: 500, body: JSON.stringify('Internal error') });
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        helper.expectNoCalls(lamdbaInvokeStub, countSettledSavesStub, findMostCommonCurrencyStub, sumAccountBalanceStub, redisSetStub);
    });

});

