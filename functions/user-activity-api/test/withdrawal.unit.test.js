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
const fetchTransactionStub = sinon.stub();
const countSettledSavesStub = sinon.stub();
const sumAccountBalanceStub = sinon.stub();

const getOwnerInfoForAccountStub = sinon.stub();
const fetchBankRefInfoStub = sinon.stub();
const generateBankRefStub = sinon.stub();

const findMostCommonCurrencyStub = sinon.stub();
const addTransactionToAccountStub = sinon.stub();
const updateTxSettlementStatusStub = sinon.stub();
const fetchFloatVarsForBalanceCalcStub = sinon.stub();

const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

class MockRedis {
    constructor () { 
        this.get = redisGetStub;
        this.set = redisSetStub;
    }
}

const handler = proxyquire('../withdrawal-handler', {
    'publish-common': {
        'publishUserEvent': publishEventStub,
        '@noCallThru': true
    },
    './persistence/rds': {
        'fetchTransaction': fetchTransactionStub,
        'countSettledSaves': countSettledSavesStub,
        'sumAccountBalance': sumAccountBalanceStub,
        'getOwnerInfoForAccount': getOwnerInfoForAccountStub,
        'findMostCommonCurrency': findMostCommonCurrencyStub,
        'addTransactionToAccount': addTransactionToAccountStub,
        'updateTxSettlementStatus': updateTxSettlementStatusStub,
        'fetchInfoForBankRef': fetchBankRefInfoStub,
        '@noCallThru': true
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsForBalanceCalcStub,
        '@noCallThru': true
    },
    './payment-link': {
        'generateBankRef': generateBankRefStub
    },
    'ioredis': MockRedis,
    'aws-sdk': { 'Lambda': MockLambdaClient },
    'moment': momentStub
});

const mockBankVerifyResponse = (result) => ({
    StatusCode: 200,
    Payload: JSON.stringify({ result, jobId: 'KSDF382' })
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
            publishEventStub, redisGetStub, redisSetStub, lamdbaInvokeStub, sumAccountBalanceStub, 
            updateTxSettlementStatusStub, fetchTransactionStub, countSettledSavesStub, findMostCommonCurrencyStub, 
            getOwnerInfoForAccountStub, fetchFloatVarsForBalanceCalcStub
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

    it('Returns error from unsuccessful job id retreival from third party', async () => {
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

        const expectedResult = { statusCode: 500, body: JSON.stringify(JSON.stringify({ status: 'FAILED', jobId: 'KSDF382' })) };

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
        expect(getOwnerInfoForAccountStub).to.not.have.been.called;
        expect(redisSetStub).to.have.not.been.called;
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

describe('*** UNIT TEST WITHDRAWAL AMOUNT SETTING ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();
    const testClientId = uuid();
    const testFloatId = uuid();
    const testTransactionId = uuid();

    const testInitiationTime = moment();

    const testBankDetails = {
        bankName: 'ABSA',
        accountNumber: '928392739187391',
        accountType: 'SAVINGS',
        verificationJobId: 'KSDF382'
    };

    const testBankRefInfo = { humanRef: 'JUPSAVER31', count: 15 };

    const mockFloatVars = {
        accrualRateAnnualBps: 250,
        bonusPoolShareOfAccrual: 0.1,
        clientShareOfAccrual: 0.1,
        prudentialFactor: 0.1
    };

    beforeEach(() => {
        helper.resetStubs(
            momentStub, publishEventStub, redisGetStub, redisSetStub, sumAccountBalanceStub, addTransactionToAccountStub, 
            getOwnerInfoForAccountStub, lamdbaInvokeStub, fetchBankRefInfoStub, generateBankRefStub
        );
    });

    it('Sets withdrawal amount', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 100000, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        const mockInitializeVerificationResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'VERIFIED',
                jobId: 'KSDF382'
            })
        };

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockInitializeVerificationResponse });
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        fetchBankRefInfoStub.resolves(testBankRefInfo);
        generateBankRefStub.resolves('JUPSAVER-16');
        addTransactionToAccountStub.resolves({ transactionDetails: [{ accountTransactionId: testTransactionId }] });

        const testAccrualRateBps = 250;
        const testBonusPoolShare = 0.1; // percent of an accrual (not bps)
        const testClientCoShare = 0.05; // as above
        const testPrudentialDiscountFactor = 0.1; // percent, how much to reduce projected increment by

        fetchFloatVarsForBalanceCalcStub.withArgs(testClientId, testFloatId).resolves({
            accrualRateAnnualBps: testAccrualRateBps,
            bonusPoolShareOfAccrual: testBonusPoolShare,
            clientShareOfAccrual: testClientCoShare,
            prudentialFactor: testPrudentialDiscountFactor
        });

        const requiredInterestBps = testAccrualRateBps * (1 - testBonusPoolShare - testClientCoShare); 
        // eslint-disable-next-line no-mixed-operators
        const annualIncrease = (1 + requiredInterestBps / 10000);
        const fiveYearTotal = Math.pow(annualIncrease, 5);
        
        const testCompoundInterest = Math.floor(100000 * (fiveYearTotal - 1));

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                transactionId: testTransactionId,
                potentialInterest: { amount: testCompoundInterest, unit: 'HUNDREDTH_CENT', currency: 'USD' }
            })
        };

        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'USD');
        expect(getOwnerInfoForAccountStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(fetchBankRefInfoStub).to.have.been.calledOnceWithExactly(testAccountId);

        const expectedBankRefParams = { bankRefStem: 'JUPSAVER31', priorSaveCount: 15 };
        expect(generateBankRefStub).to.have.been.calledOnceWithExactly(expectedBankRefParams);
        expect(fetchFloatVarsForBalanceCalcStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        // expect(addTransactionToAccountStub).to.have.been.calledOnceWithExactly(getOwnerArgs);

        const expectedLogOptions = { context: { resultFromVerifier: { jobId: 'KSDF382', result: 'VERIFIED' } } };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'BANK_VERIFICATION_SUCCEEDED', expectedLogOptions);

        const modifiedBankDetails = { ...testBankDetails };
        modifiedBankDetails.verificationStatus = 'VERIFIED';
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);
    });

    it('Sets withdrawal amount, converting units and rounding appropriately', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: -250100.00000000003, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockBankVerifyResponse('VERIFIED') });
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        fetchBankRefInfoStub.resolves(testBankRefInfo);
        generateBankRefStub.resolves('JUPSAVER-16');
        addTransactionToAccountStub.resolves({ transactionDetails: [{ accountTransactionId: testTransactionId }] });

        // calcs are tested above, not point here
        fetchFloatVarsForBalanceCalcStub.withArgs(testClientId, testFloatId).resolves(mockFloatVars);

        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        const resultBody = helper.standardOkayChecks(resultOfSetting);
        expect(resultBody).to.have.property('transactionId', testTransactionId);

        // other expectations are covered above
        const addTransactionArgs = addTransactionToAccountStub.getCall(0).args;
        const transactionDetails = addTransactionArgs[0];
        expect(transactionDetails.amount).to.equal(-250100);
        // expect(addTransactionToAccountStub).to.have.been.calledOnceWithExactly(getOwnerArgs);
    });

    it('Fails on missing context user id', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' });

        const expectedResult = { statusCode: 403, message: 'User ID not found in context' };

        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.not.been.called;
        expect(redisGetStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(getOwnerInfoForAccountStub).to.have.not.been.called;
        expect(addTransactionToAccountStub).to.have.not.been.called;
    });

    it('Logs result of bank account failure', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        const mockVerifyResult = mockBankVerifyResponse('FAILED');

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockVerifyResult });
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        fetchBankRefInfoStub.resolves(testBankRefInfo);
        generateBankRefStub.resolves('JUPSAVER-16');
        addTransactionToAccountStub.resolves({ transactionDetails: [{ accountTransactionId: testTransactionId }] });

        // calcs are tested above, not point here
        fetchFloatVarsForBalanceCalcStub.withArgs(testClientId, testFloatId).resolves(mockFloatVars);

        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        const resultBody = helper.standardOkayChecks(resultOfSetting);
        expect(resultBody).to.have.property('transactionId', testTransactionId);

        // other expectations are covered above
        const expectedLogOptions = { context: { resultFromVerifier: { jobId: 'KSDF382', result: 'FAILED' } } };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'BANK_VERIFICATION_FAILED', expectedLogOptions);

        const modifiedBankDetails = { ...testBankDetails };
        modifiedBankDetails.verificationStatus = 'FAILED';
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);

    });

    it('Fails on invalid withdrawal parameters', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        const mockVerifyResult = mockBankVerifyResponse('VERIFIED');

        const expectedResult = { statusCode: 400, body: 'Error, must send amount to withdraw, along with unit and currency' };

        const setupStubs = () => {
            momentStub.returns({ add: () => testInitiationTime });
            redisGetStub.resolves(JSON.stringify(testBankDetails));
            lamdbaInvokeStub.returns({ promise: () => mockVerifyResult });
            sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        };

        const commonAssertions = (resultOfSetting) => {
            expect(resultOfSetting).to.deep.equal(expectedResult);
            helper.expectNoCalls(redisGetStub, lamdbaInvokeStub, sumAccountBalanceStub, getOwnerInfoForAccountStub, addTransactionToAccountStub);
            helper.resetStubs(momentStub, publishEventStub, redisGetStub, sumAccountBalanceStub, addTransactionToAccountStub, getOwnerInfoForAccountStub, lamdbaInvokeStub);
        };

        setupStubs();
        event.body = JSON.stringify({ accountId: testAccountId, unit: 'HUNDREDTH_CENT', currency: 'USD' });
        const missingAmountResult = await handler.setWithdrawalAmount(event);
        commonAssertions(missingAmountResult);

        setupStubs();
        event.body = JSON.stringify({ accountId: testAccountId, amount: 10, currency: 'USD' });
        const missingUnitResult = await handler.setWithdrawalAmount(event);
        commonAssertions(missingUnitResult);

        setupStubs();
        event.body = JSON.stringify({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT' });
        const missingCurrencyResult = await handler.setWithdrawalAmount(event);
        commonAssertions(missingCurrencyResult);
    });

    it('Fails where withdrawal amount is greater than available balance', async () => {
        const testBody = { accountId: testAccountId, amount: 11, unit: 'HUNDREDTH_CENT', currency: 'USD' };
        const event = helper.wrapEvent(testBody, testUserId);

        const expectedResult = { statusCode: 400, body: 'Error, trying to withdraw more than available' };

        momentStub.returns({ add: () => testInitiationTime });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockBankVerifyResponse('VERIFIED') });
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
     
        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'USD');
        helper.expectNoCalls(redisGetStub, redisGetStub, lamdbaInvokeStub, getOwnerInfoForAccountStub, addTransactionToAccountStub);
    });

    it('Catches thrown errors', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        redisGetStub.throws(new Error('Internal Error'));

        const expectedResult = { statusCode: 500, body: JSON.stringify('Internal Error') };
        
        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        helper.expectNoCalls(addTransactionToAccountStub, redisSetStub);
    });

});

describe('*** UNIT TEST WITHDRAWAL CONFIRMATION ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();
    const testTransactionId = uuid();

    const testSettlementTime = moment();

    const testBankDetails = {
        bankName: 'ABSA',
        accountNumber: '928392739187391',
        accountType: 'SAVINGS',
        verificationJobId: 'KSDF382',
        verificationStatus: 'VERIFIED'
    };

    const testTransaction = {
        accountId: testAccountId,
        settlementTime: testSettlementTime.valueOf(),
        amount: 100,
        unit: 'HUNDREDTH_CENT',
        currency: 'ZAR'
    };

    beforeEach(() => {
        helper.resetStubs(publishEventStub, redisGetStub, redisSetStub, lamdbaInvokeStub, updateTxSettlementStatusStub, fetchTransactionStub, sumAccountBalanceStub);
    });

    it('Confirms user withdrawal', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        publishEventStub.resolves({ result: 'SUCCESS' });
        redisGetStub.resolves(JSON.stringify(testBankDetails));

        lamdbaInvokeStub.returns({ promise: () => mockBankVerifyResponse('VERIFIED') });
        
        updateTxSettlementStatusStub.resolves({ newBalance: { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }});
        fetchTransactionStub.resolves(testTransaction);
        sumAccountBalanceStub.resolves({ amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null });

        const testPublishContext = {
            context: {
                transactionId: testTransactionId,
                accountId: testAccountId,
                timeInMillis: testSettlementTime.valueOf(),
                withdrawalAmount: '100::HUNDREDTH_CENT::ZAR',
                newBalance: '100::HUNDREDTH_CENT::ZAR'
            }
        };

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }}) };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(lamdbaInvokeStub).to.not.have.been.called;
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, settlementStatus: 'PENDING' });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(testTransactionId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_CONFIRMED', testPublishContext);
    });

    it('Cancels user withdrawal', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'CANCEL' }, testUserId);

        fetchTransactionStub.resolves({ accountId: testAccountId, settlementStatus: 'PENDING' });
        updateTxSettlementStatusStub.resolves(moment());
        publishEventStub.resolves({ result: 'SUCCESS' });

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal cancellation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal({ statusCode: 200 });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(testTransactionId);

        const txLogContext = { newStatus: 'CANCELLED', oldStatus: 'PENDING' };
        const expectedTxLog = { accountId: testAccountId, systemWideUserId: testUserId, logContext: txLogContext };
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ 
            transactionId: testTransactionId, 
            settlementStatus: 'CANCELLED', 
            logToInsert: expectedTxLog 
        });
        const userLogContext = { newStatus: 'CANCELLED', oldStatus: 'PENDING', transactionId: testTransactionId };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_CANCELLED', { context: userLogContext });

        expect(redisGetStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    // this operation is too delicate + important to user trust, and the bank account verification services are too
    // sensitive to it, so we continue but customer support must flag as fixed to complete (todo : insert that)
    it('Continues on previously cached invalid bank account (admin will verify prior to completion)', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        const cachedBankDetails = { verificationStatus: false, failureReason: 'User bank account verification failed' };
        redisGetStub.resolves(JSON.stringify(cachedBankDetails));

        updateTxSettlementStatusStub.resolves({ newBalance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }});
        fetchTransactionStub.resolves(testTransaction);
        sumAccountBalanceStub.resolves({ amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null });

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }}) };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, settlementStatus: 'PENDING' });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(testTransactionId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(publishEventStub).to.have.been.calledOnceWith(testUserId, 'WITHDRAWAL_EVENT_CONFIRMED', sinon.match.any);    
    });

    it('Caches bank verification failure but continues (as above)', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        const mockDetails = { ...testBankDetails, verificationStatus: 'PENDING' };
        redisGetStub.resolves(JSON.stringify(mockDetails));

        const mockLambdaResponse = mockBankVerifyResponse('FAILED');
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });
        
        sumAccountBalanceStub.resolves({ amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null });
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ newBalance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }});

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }}) };

        const confirmationResult = await handler.confirmWithdrawal(event);

        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));

        const expectedLogOptions = { context: { resultFromVerifier: { jobId: 'KSDF382', result: 'FAILED' } } };
        expect(publishEventStub).to.have.been.calledTwice; // otherwise is confirmation event
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'BANK_VERIFICATION_FAILED', expectedLogOptions);

        const modifiedBankDetails = { ...testBankDetails };
        modifiedBankDetails.verificationStatus = 'FAILED';
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);
    });

    it('Ignores unsuccessful job id invocation (if Lambda issue)', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        const mockLambdaResponse = {
            StatusCode: 401,
            Payload: JSON.stringify({ message: 'Internal error' })
        };

        const mockDetails = { ...testBankDetails };
        Reflect.deleteProperty(mockDetails, 'verificationStatus');
        redisGetStub.resolves(JSON.stringify(mockDetails));
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });

        sumAccountBalanceStub.resolves({ amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null });
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ newBalance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }});

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }}) };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWithExactly(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        const modifiedBankDetails = { ...testBankDetails };
        modifiedBankDetails.verificationStatus = 'PENDING';
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);
    });

    it('Publishes manual verification requirement if job ID missing', async () => {    
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        const invalidBankDetails = {
            bankName: 'ABSA',
            accountNumber: '928392739187391',
            accountType: 'SAVINGS'
        };

        redisGetStub.resolves(JSON.stringify(invalidBankDetails));

        sumAccountBalanceStub.resolves({ amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null });
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ newBalance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }});

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }}) };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWithExactly(testUserId);
        
        expect(lamdbaInvokeStub).to.not.have.been.called;

        const modifiedBankDetails = { ...invalidBankDetails };
        modifiedBankDetails.verificationStatus = 'MANUAL';
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);

        expect(publishEventStub).to.have.been.calledTwice;
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'BANK_VERIFICATION_MANUAL', { context: { cause: 'No bank verification job ID' }});
    });

    it('Publishes manual verification if error result from third party', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        const mockDetails = { ...testBankDetails, verificationStatus: 'PENDING' };
        redisGetStub.resolves(JSON.stringify(mockDetails));

        const mockLambdaResponse = mockBankVerifyResponse('ERROR');
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });
        
        sumAccountBalanceStub.resolves({ amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null });
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ newBalance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }});

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }}) };

        const confirmationResult = await handler.confirmWithdrawal(event);

        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));

        const expectedLogOptions = { context: { cause: 'Error on third party bank verification service' } };
        expect(publishEventStub).to.have.been.calledTwice; // otherwise is confirmation event
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'BANK_VERIFICATION_MANUAL', expectedLogOptions);

        const modifiedBankDetails = { ...testBankDetails };
        modifiedBankDetails.verificationStatus = 'PENDING';
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);
    });


    it('Returns error where transaction update returns empty rows', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        publishEventStub.resolves({ result: 'SUCCESS' });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockBankVerifyResponse });
        updateTxSettlementStatusStub.resolves();

        const expectedResult = { statusCode: 500, body: JSON.stringify('Transaction update returned empty rows') };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, settlementStatus: 'PENDING' });
        helper.expectNoCalls(lamdbaInvokeStub, fetchTransactionStub, sumAccountBalanceStub, publishEventStub);
    });

    it('Fails on missing context user id', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' });

        const expectedResult = { statusCode: 403, message: 'User ID not found in context' };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        helper.expectNoCalls(publishEventStub, redisGetStub, lamdbaInvokeStub, updateTxSettlementStatusStub, fetchTransactionStub);
    });

    it('Fails on missing transaction id', async () => {
        const event = helper.wrapEvent({ userDecision: 'WITHDRAW' }, testUserId);

        const expectedResult = { statusCode: 400, body: 'Requires a transaction Id' };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        helper.expectNoCalls(publishEventStub, redisGetStub, lamdbaInvokeStub, updateTxSettlementStatusStub, fetchTransactionStub);
    });

    it('Fails on missing user decision', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId }, testUserId);

        const expectedResult = { statusCode: 400, body: 'Requires a valid user decision' };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        helper.expectNoCalls(publishEventStub, redisGetStub, lamdbaInvokeStub, updateTxSettlementStatusStub, fetchTransactionStub);
    });

    it('Catches thrown errors', async () => {
        const event = helper.wrapEvent({ transactionId: testTransactionId, userDecision: 'WITHDRAW' }, testUserId);

        redisGetStub.throws(new Error('Error'));

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal({ statusCode: 500, body: JSON.stringify('Error') });
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        helper.expectNoCalls(publishEventStub, lamdbaInvokeStub, updateTxSettlementStatusStub, fetchTransactionStub);
    });
});
