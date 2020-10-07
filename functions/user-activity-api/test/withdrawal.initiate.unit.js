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
const fetchPendingTxStub = sinon.stub();

const getOwnerInfoForAccountStub = sinon.stub();
const generateBankRefStub = sinon.stub();

const findMostCommonCurrencyStub = sinon.stub();
const fetchFloatVarsForBalanceCalcStub = sinon.stub();

const checkPriorBankVerificationStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
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
        'fetchPendingTransactions': fetchPendingTxStub,
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
        personalName: 'John',
        familyName: 'Doe',
        countryCode: testCountryCode,
        nationalId: testNationalId,
        kycStatus: 'CONTACT_VERIFIED'
    };

    const mockInterestVars = {
        accrualRateAnnualBps: 750,
        bonusPoolShareOfAccrual: 0.1,
        clientShareOfAccrual: 0.1,
        prudentialFactor: 0
    };

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({ statusCode, body: JSON.stringify(body) })
    });

    const mockInitiateBankResponse = (status, jobId) => ({ StatusCode: 200, Payload: JSON.stringify({ status, jobId })});

    beforeEach(() => {
        helper.resetStubs(
            publishEventStub, redisGetStub, redisSetStub, lambdaInvokeStub, sumAccountBalanceStub, 
            fetchPendingTxStub, countSettledSavesStub, findMostCommonCurrencyStub, 
            getOwnerInfoForAccountStub, fetchFloatVarsForBalanceCalcStub, checkPriorBankVerificationStub
        );
    });

    it('Sets withdrawal bank account, no prior verification, happy path', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, bankDetails: testBankDetails }, testUserId);

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

        const mockInitializeVerificationResponse = mockInitiateBankResponse('SUCCESS', 'KSDF382');

        publishEventStub.resolves({ result: 'SUCCESS' });
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);

        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);

        redisSetStub.resolves();

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                availableBalance: { amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null },
                cardTitle: 'Are you sure?',
                cardBody: 'Every R100 kept in your Jupiter account earns you at least R6 after a year - hard at work earning for you! If possible, delay or reduce your withdrawal and keep your money earning for you'
            })
        };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');

        expect(checkPriorBankVerificationStub).to.have.been.calledOnceWithExactly(testUserId, testBankDetails);
        
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, mockJobIdPayload));
        
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');

        const expectedCachedDetails = { ...testBankDetails, verificationStatus: 'PENDING', verificationJobId: 'KSDF382' };
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(expectedCachedDetails), 'EX', config.get('cache.detailsTTL'));
    });

    it('Uses prior verification result if available, and deducts pending withdrawals from available', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, bankDetails: testBankDetails }, testUserId);

        publishEventStub.resolves({ result: 'SUCCESS' });
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('USD');
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);

        const mockVerificationStoreTime = moment().subtract(2, 'months');
        checkPriorBankVerificationStub.resolves({ verificationStatus: 'VERIFIED', creationMoment: mockVerificationStoreTime });

        sumAccountBalanceStub.resolves({ amount: 10 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([{ transactionId: 'some-tx', transactionType: 'WITHDRAWAL', amount: -1, unit: 'WHOLE_CURRENCY', currency: 'USD' }]);

        redisSetStub.resolves();

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                availableBalance: { amount: 9 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null },
                cardTitle: 'Are you sure?',
                cardBody: 'Every R100 kept in your Jupiter account earns you at least R6 after a year - hard at work earning for you! If possible, delay or reduce your withdrawal and keep your money earning for you'
            })
        };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');

        expect(checkPriorBankVerificationStub).to.have.been.calledOnceWithExactly(testUserId, testBankDetails);
        
        expect(lambdaInvokeStub).to.have.been.calledOnce; // profile args tested above
        
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'USD');
        expect(fetchPendingTxStub).to.have.been.calledOnceWith(testAccountId);

        const expectedCachedDetails = { ...testBankDetails, verificationStatus: 'VERIFIED', verificationTime: mockVerificationStoreTime.format('DD MMMM, YYYY') };
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(expectedCachedDetails), 'EX', config.get('cache.detailsTTL'));
    });

    it('Fails where user has no savings', async () => {
        const event = helper.wrapEvent({
                accountId: testAccountId,
                bankDetails: testBankDetails,
                clientId: testClientId,
                floatId: testFloatId
        }, testUserId);

        const mockInitializeVerificationResponse = mockInitiateBankResponse('SUCCESS', 'KSDF382');

        publishEventStub.resolves({ result: 'SUCCESS' });
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        countSettledSavesStub.resolves(0);
        findMostCommonCurrencyStub.resolves('ZAR');

        const expectedResult = { statusCode: 400, body: { result: 'USER_HAS_NOT_SAVED' } };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);

        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
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
        helper.expectNoCalls(publishEventStub, lambdaInvokeStub, countSettledSavesStub, findMostCommonCurrencyStub, sumAccountBalanceStub, redisSetStub);
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
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        getOwnerInfoForAccountStub.resolves({ clientId: testClientId, floatId: testFloatId });
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);

        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);

        const expectedResult = { statusCode: 500, body: JSON.stringify(JSON.stringify({ message: 'Internal error'})) };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, mockJobIdPayload));
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(fetchPendingTxStub).to.have.been.calledOnceWith(testAccountId);
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

        const mockInitializeVerificationResponse = mockInitiateBankResponse('FAILED', 'KSDF382');

        publishEventStub.resolves({ result: 'SUCCESS' });
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => mockInitializeVerificationResponse });

        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        fetchFloatVarsForBalanceCalcStub.resolves(mockInterestVars);
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                availableBalance: { amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null },
                cardTitle: 'Are you sure?',
                cardBody: 'Every R100 kept in your Jupiter account earns you at least R6 after a year - hard at work earning for you! If possible, delay or reduce your withdrawal and keep your money earning for you'
            })
        };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify({
            ...testBankDetails, verificationStatus: 'PENDING', verificationJobId: 'MANUAL_JOB'
        }), 'EX', 900);

        // covered above but leave here to be sure
        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, mockJobIdPayload));
        
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(fetchPendingTxStub).to.have.been.calledOnceWith(testAccountId);
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
        helper.expectNoCalls(lambdaInvokeStub, countSettledSavesStub, findMostCommonCurrencyStub, sumAccountBalanceStub, redisSetStub);
    });

});

