'use strict';

const logger = require('debug')('jupiter:user-activity-withdrawal-test');
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
        'publishUserEvent': publishEventStub
    },
    './persistence/rds': {
        'fetchTransaction': fetchTransactionStub,
        'countSettledSaves': countSettledSavesStub,
        'sumAccountBalance': sumAccountBalanceStub,
        'getOwnerInfoForAccount': getOwnerInfoForAccountStub,
        'findMostCommonCurrency': findMostCommonCurrencyStub,
        'addTransactionToAccount': addTransactionToAccountStub,
        'updateTxSettlementStatus': updateTxSettlementStatusStub
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsForBalanceCalcStub
    },
    'ioredis': MockRedis,
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

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    beforeEach(() => {
        helper.resetStubs(publishEventStub, redisGetStub, redisSetStub, lamdbaInvokeStub, sumAccountBalanceStub, updateTxSettlementStatusStub, fetchTransactionStub, countSettledSavesStub, findMostCommonCurrencyStub);
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

        const mockJobIdLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                status: 'SUCCESS',
                jobId: 'KSDF382'
            })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockJobIdLambdaResponse });
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        redisSetStub.resolves();

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                availableBalance: { amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null },
                cardTitle: 'Did you know?',
                cardBody: 'Over the next two years you could accumulate xx% interest. Why not delay your withdraw to keep these savings and earn more for your future!'
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

        const mockJobIdLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                status: 'SUCCESS',
                jobId: 'KSDF382'
            })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockJobIdLambdaResponse });
        countSettledSavesStub.resolves(0);
        findMostCommonCurrencyStub.resolves('ZAR');

        const expectedResult = { statusCode: 400, body: { result: 'USER_HAS_NOT_SAVED' } };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId }));
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMostCommonCurrencyStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(redisSetStub).to.have.not.been.called;
    });

    it('Fails on missing context user id', async () => {
        const event = {
            requestContext: {
                authorizer: { role: 'ORDINARY_USER' }
            },
            body: JSON.stringify({ accountId: testAccountId, bankDetails: testBankDetails })
        };

        const expectedResult = { statusCode: 403, message: 'User ID not found in context' };

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(countSettledSavesStub).to.have.not.been.called;
        expect(findMostCommonCurrencyStub).to.have.not.been.called;
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(redisSetStub).to.have.not.been.called;
    });

    it('Returns error from unsuccessful job id invocation', async () => {
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

        const mockJobIdLambdaResponse = {
            StatusCode: 401,
            Payload: JSON.stringify({ message: 'Internal error' })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockJobIdLambdaResponse });
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });

        const expectedResult = { statusCode: 500, body: JSON.stringify(JSON.stringify({ message: 'Internal error'})) };

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
        expect(redisSetStub).to.have.not.been.called;
    });

    it('Returns error from unsuccessful job id retreival from third party', async () => {
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

        const mockJobIdLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                status: 'FAILED',
                jobId: 'KSDF382'
            })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockJobIdLambdaResponse });
        countSettledSavesStub.resolves(5);
        findMostCommonCurrencyStub.resolves('ZAR');
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
        expect(redisSetStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const event = {
            requestContext: {
                authorizer: { role: 'ORDINARY_USER', systemWideUserId: testUserId }
            },
            body: JSON.stringify({
                accountId: testAccountId,
                bankDetails: testBankDetails
            })
        };

        publishEventStub.throws(new Error('Internal error'));

        const resultOfSetting = await handler.setWithdrawalBankAccount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal({ statusCode: 500, body: JSON.stringify('Internal error') });
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_INITIATED');
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(countSettledSavesStub).to.have.not.been.called;
        expect(findMostCommonCurrencyStub).to.have.not.been.called;
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(redisSetStub).to.have.not.been.called;
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

    beforeEach(() => {
        helper.resetStubs(momentStub, publishEventStub, redisGetStub, sumAccountBalanceStub, addTransactionToAccountStub, getOwnerInfoForAccountStub, lamdbaInvokeStub);
    });


    it('Sets withdrawal amount', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' })
        };

        // const getOwnerArgs = {
        //     accountId: testAccountId,
        //     amount: -10,
        //     unit: 'HUNDREDTH_CENT',
        //     currency: 'USD',
        //     transactionType: 'WITHDRAWAL',
        //     settlementStatus: 'INITIATED',
        //     initiationTime: testInitiationTime.add(1, 'week'),
        //     floatId: testFloatId,
        //     clientId: testClientId
        // };

        const mockJobIdLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'VERIFIED',
                jobId: 'KSDF382'
            })
        };

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                transactionId: testTransactionId,
                delayOffer: { boostAmount: '30000::HUNDREDTH_CENT::ZAR', requiredDelay: testInitiationTime.add(1, 'week') },
                potentialInterest: '0.973321632671356201171875'
            })
        };

        momentStub.returns({ add: () => testInitiationTime });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockJobIdLambdaResponse });
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        getOwnerInfoForAccountStub.resolves({ floatId: testFloatId, clientId: testClientId });
        addTransactionToAccountStub.resolves({ transactionDetails: [{ accountTransactionId: testTransactionId }] });
        const testAccrualRateBps = 250;
        const testBonusPoolShare = 0.1; // percent of an accrual (not bps)
        const testClientCoShare = 0.05; // as above
        const testPrudentialDiscountFactor = 0.1; // percent, how much to reduce projected increment by
        const testReferenceRate = Math.floor(testAccrualRateBps * (1 - testBonusPoolShare - testClientCoShare));
        const testComparatorRates = { referenceRate: testReferenceRate, intervalUnit: 'WHOLE_CURRENCY' };

        fetchFloatVarsForBalanceCalcStub.withArgs(testClientId, testFloatId).resolves({
            accrualRateAnnualBps: testAccrualRateBps,
            bonusPoolShareOfAccrual: testBonusPoolShare,
            clientShareOfAccrual: testClientCoShare,
            prudentialFactor: testPrudentialDiscountFactor,
            defaultTimezone: 'America/New_York',
            currency: 'USD',
            comparatorRates: testComparatorRates
        });

        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'USD');
        expect(getOwnerInfoForAccountStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(fetchFloatVarsForBalanceCalcStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        // expect(addTransactionToAccountStub).to.have.been.calledOnceWithExactly(getOwnerArgs);
    });

    it('Fails on missing context user id', async () => {
        const event = {
            requestContext: {
                authorizer: { role: 'ORDINARY_USER' }
            },
            body: JSON.stringify({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' })
        };

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

    it('Fails on invalid user bank account', async () => {
        const event = {
            requestContext: {
                authorizer: { role: 'ORDINARY_USER', systemWideUserId: testUserId }
            },
            body: JSON.stringify({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' })
        };

        const expectedResult = { statusCode: 400, body: { result: 'BANK_ACCOUNT_INVALID' } };

        const cachedBankDetails = { verificationStatus: false, failureReason: 'User bank account verification failed' };
        redisGetStub.resolves(JSON.stringify(cachedBankDetails));

        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(getOwnerInfoForAccountStub).to.have.not.been.called;
        expect(addTransactionToAccountStub).to.have.not.been.called;
    });

    it('Fails on invalid withdrawal parameters', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' })
        };

        const mockJobIdLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'VERIFIED',
                jobId: 'KSDF382'
            })
        };

        const expectedResult = { statusCode: 400, body: 'Error, must send amount to withdraw, along with unit and currency' };

        const setupStubs = () => {
            momentStub.returns({ add: () => testInitiationTime });
            redisGetStub.resolves(JSON.stringify(testBankDetails));
            lamdbaInvokeStub.returns({ promise: () => mockJobIdLambdaResponse });
            sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        };

        const commonAssertions = (resultOfSetting) => {
            expect(resultOfSetting).to.exist;
            expect(resultOfSetting).to.deep.equal(expectedResult);
            expect(redisGetStub).to.have.been.calledTwice;
            expect(redisGetStub).to.have.been.calledWith(testUserId);
            expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
            expect(sumAccountBalanceStub).to.have.not.been.called;
            expect(getOwnerInfoForAccountStub).to.have.not.been.called;
            expect(addTransactionToAccountStub).to.have.not.been.called;
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
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ accountId: testAccountId, amount: 11, unit: 'HUNDREDTH_CENT', currency: 'USD' })
        };

        const mockJobIdLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'VERIFIED',
                jobId: 'KSDF382'
            })
        };

        const expectedResult = { statusCode: 400, body: 'Error, trying to withdraw more than available' };

        momentStub.returns({ add: () => testInitiationTime });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockJobIdLambdaResponse });
        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
     
        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'USD');
        expect(getOwnerInfoForAccountStub).to.have.not.been.called;
        expect(addTransactionToAccountStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' })
        };

        redisGetStub.throws(new Error('Internal Error'));

        const expectedResult = { statusCode: 500, body: JSON.stringify('Internal Error') };
        
        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.exist;
        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(getOwnerInfoForAccountStub).to.have.not.been.called;
        expect(addTransactionToAccountStub).to.have.not.been.called;
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
        verificationJobId: 'KSDF382'
    };

    const mockJobIdLambdaResponse = {
        StatusCode: 200,
        Payload: JSON.stringify({
            result: 'VERIFIED',
            jobId: 'KSDF382'
        })
    };

    beforeEach(() => {
        helper.resetStubs(publishEventStub, redisGetStub, lamdbaInvokeStub, updateTxSettlementStatusStub, fetchTransactionStub, sumAccountBalanceStub);
    });

    it('Confirms user withdrawal', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const testTransaction = {
            accountId: testAccountId,
            settlementTime: testSettlementTime.valueOf(),
            amount: 100,
            unit: 'HUNDREDTH_CENT',
            currency: 'ZAR'
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockJobIdLambdaResponse });
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
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, settlementStatus: 'PENDING' });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(testTransactionId);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR');
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_CONFIRMED', testPublishContext);
    });

    it('Cancels user withdrawal', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'CANCEL' })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal cancellation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal({ statusCode: 200 });
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'WITHDRAWAL_EVENT_CANCELLED');
        expect(redisGetStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Returns error where transaction update returns empty rows', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockJobIdLambdaResponse });
        updateTxSettlementStatusStub.resolves();

        const expectedResult = { statusCode: 500, body: JSON.stringify('Transaction update returned empty rows') };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, settlementStatus: 'PENDING' });
        expect(fetchTransactionStub).to.have.not.been.called;
        expect(sumAccountBalanceStub).to.have.not.been.called;
        expect(publishEventStub).to.have.not.been.called;
    });

    it('Fails on missing context user id', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER'
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const expectedResult = { statusCode: 403, message: 'User ID not found in context' };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.not.been.called;
        expect(redisGetStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Fails on missing transaction id', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ userDecision: 'WITHDRAW' })
        };

        const expectedResult = { statusCode: 400, body: 'Requires a transaction Id' };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.not.been.called;
        expect(redisGetStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Fails on missing user decision', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId })
        };

        const expectedResult = { statusCode: 400, body: 'Requires a valid user decision' };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(publishEventStub).to.have.not.been.called;
        expect(redisGetStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Fails on invalid user bank account', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const cachedBankDetails = { verificationStatus: false, failureReason: 'User bank account verification failed' };
        redisGetStub.resolves(JSON.stringify(cachedBankDetails));

        const expectedResult = { statusCode: 400, body: { result: 'BANK_ACCOUNT_INVALID' } };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Fails on invalid user bank account, caches verification result', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const mockLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'FAILED',
                jobId: 'KSDF382'
            })
        };

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });

        const expectedResult = { statusCode: 400, body: { result: 'BANK_ACCOUNT_INVALID' } };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Returns error on unseccessful job id invocation', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const mockLambdaResponse = {
            StatusCode: 401,
            Payload: JSON.stringify({ message: 'Internal error' })
        };

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });

        const expectedResult = { statusCode: 500, body: JSON.stringify(JSON.stringify({ message: 'Internal error'})) };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Returns error on unsuccessful job id retreival from third party', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const mockLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({ message: 'Third party error' })
        };

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });

        const expectedResult = { statusCode: 500, body: JSON.stringify(JSON.stringify({ message: 'Third party error'})) };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Returns error on missing job id in cached bank details', async () => {    
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        const invalidBankDetails = {
            bankName: 'ABSA',
            accountNumber: '928392739187391',
            accountType: 'SAVINGS'
        };

        const mockLambdaResponse = {
            StatusCode: 200,
            Payload: JSON.stringify({ message: 'Third party error' })
        };

        redisGetStub.resolves(JSON.stringify(invalidBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse });

        const expectedResult = { statusCode: 500, body: JSON.stringify('No job ID for bank verification') };

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const event = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({ transactionId: testTransactionId, userDecision: 'WITHDRAW' })
        };

        redisGetStub.throws(new Error('Error'));

        const confirmationResult = await handler.confirmWithdrawal(event);
        logger('Result of withdrawal confirmation:', confirmationResult);

        expect(confirmationResult).to.exist;
        expect(confirmationResult).to.deep.equal({ statusCode: 500, body: JSON.stringify('Error') });
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(publishEventStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(updateTxSettlementStatusStub).to.have.not.been.called;
        expect(fetchTransactionStub).to.have.not.been.called;
    });
});
