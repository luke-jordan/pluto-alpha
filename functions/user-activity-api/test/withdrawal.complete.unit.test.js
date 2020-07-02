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

const fetchTransactionStub = sinon.stub();
const sumAccountBalanceStub = sinon.stub();
const getOwnerInfoForAccountStub = sinon.stub();
const fetchBankRefInfoStub = sinon.stub();
const generateBankRefStub = sinon.stub();
const fetchPendingTxStub = sinon.stub();

const addTransactionToAccountStub = sinon.stub();
const updateTxSettlementStatusStub = sinon.stub();
const fetchFloatVarsForBalanceCalcStub = sinon.stub();

const checkPriorBankVerificationStub = sinon.stub();
const storeBankVerificationStub = sinon.stub();

const publishEventStub = sinon.stub();
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
        'fetchTransaction': fetchTransactionStub,
        'sumAccountBalance': sumAccountBalanceStub,
        'getOwnerInfoForAccount': getOwnerInfoForAccountStub,
        'addTransactionToAccount': addTransactionToAccountStub,
        'updateTxSettlementStatus': updateTxSettlementStatusStub,
        'fetchInfoForBankRef': fetchBankRefInfoStub,
        'fetchPendingTransactions': fetchPendingTxStub,
        '@noCallThru': true
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsForBalanceCalcStub,
        'fetchBankVerificationResult': checkPriorBankVerificationStub,
        'setBankVerificationResult': storeBankVerificationStub,
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

const mockBankVerifyResponse = (result) => ({
    StatusCode: 200,
    Payload: JSON.stringify({ result, jobId: 'KSDF382' })
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
            getOwnerInfoForAccountStub, lamdbaInvokeStub, fetchBankRefInfoStub, generateBankRefStub, 
            fetchPendingTxStub, checkPriorBankVerificationStub, storeBankVerificationStub
        );
    });

    it('Sets withdrawal amount', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 100000, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        const mockInitializeVerificationResponse = mockBankVerifyResponse('VERIFIED');
        const mockVerifyStashTime = moment();

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockInitializeVerificationResponse });
        // in _theory_, could use persisted time from verification details stashing, _but_ would mean sequential instead of parallel call,
        // and in no plausible way is the extra few milliseconds of accuracy worth that
        momentStub.returns(mockVerifyStashTime.clone()); 
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);
        
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
        expect(resultOfSetting).to.deep.equal(expectedResult);

        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        
        const expectedBankInvoke = { operation: 'statusCheck', parameters: { jobId: 'KSDF382' } };
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, expectedBankInvoke));
        
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
        modifiedBankDetails.verificationTime = mockVerifyStashTime.format('DD MMMM, YYYY');
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);

        // eslint-disable-next-line no-undefined
        const expectedArgs = { systemWideUserId: testUserId, bankDetails: modifiedBankDetails, verificationStatus: 'VERIFIED', verificationLog: undefined };
        expect(storeBankVerificationStub).to.have.been.calledOnceWithExactly(expectedArgs);
    });

    it('Sets withdrawal amount, converting units and rounding appropriately, and ignores pending saves', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: -250100.00000000003, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockBankVerifyResponse('VERIFIED') });
        momentStub.returns(moment());
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([{ amount: 100, unit: 'WHOLE_CURRENCY', currency: 'USD', transactionType: 'USER_SAVING_EVENT' }]);

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

    it('Skips bank job checking if already exists in store, and flips cache recordingly', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10, unit: 'WHOLE_CURRENCY', currency: 'USD' }, testUserId);

        const mockInitialDetails = { ...testBankDetails, verificationStatus: 'PENDING' };
        redisGetStub.resolves(JSON.stringify(mockInitialDetails));

        const mockVerificationTime = moment().subtract(3, 'months');
        checkPriorBankVerificationStub.resolves({ verificationStatus: 'VERIFIED', creationTime: mockVerificationTime });
        redisSetStub.resolves({});
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);

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
        const mockVerificationFormatted = mockVerificationTime.format('DD MMMM, YYYY');
        const modifiedBankDetails = { ...testBankDetails, verificationStatus: 'VERIFIED', verificationTime: mockVerificationFormatted };
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);    
    });

    it('Logs result of bank account failure', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        redisGetStub.resolves(JSON.stringify(testBankDetails));
        
        const mockVerifyPayload = { result: 'FAILED', cause: 'ID number account mismatch' };
        const mockVerifyResult = { StatusCode: 200, Payload: JSON.stringify(mockVerifyPayload) };
        lamdbaInvokeStub.returns({ promise: () => mockVerifyResult });
        
        const mockMoment = moment(); // see notes above about doing this instead of using ddb result to allow parallel
        momentStub.returns(mockMoment.clone());
        
        sumAccountBalanceStub.resolves({ amount: 100000000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);
        
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
        const expectedLogOptions = { context: { resultFromVerifier: { cause: 'ID number account mismatch', result: 'FAILED' } } };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testUserId, 'BANK_VERIFICATION_FAILED', expectedLogOptions);

        const modifiedBankDetails = { 
            ...testBankDetails, 
            verificationStatus: 'FAILED', 
            failureReason: 'ID number account mismatch',
            verificationTime: mockMoment.format('DD MMMM, YYYY') 
        };
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testUserId, JSON.stringify(modifiedBankDetails), 'EX', 900);

        const expectedArgs = { systemWideUserId: testUserId, bankDetails: modifiedBankDetails, verificationStatus: 'FAILED', verificationLog: 'ID number account mismatch' };
        expect(storeBankVerificationStub).to.have.been.calledOnceWithExactly(expectedArgs);
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
        const testBody = { accountId: testAccountId, amount: 110000, unit: 'HUNDREDTH_CENT', currency: 'USD' };
        const event = helper.wrapEvent(testBody, testUserId);

        const expectedResult = { statusCode: 400, body: 'Error, trying to withdraw more than available' };

        momentStub.returns({ add: () => testInitiationTime });
        redisGetStub.resolves(JSON.stringify(testBankDetails));
        lamdbaInvokeStub.returns({ promise: () => mockBankVerifyResponse('VERIFIED') });
        sumAccountBalanceStub.resolves({ amount: 120000, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([{ amount: -2, unit: 'WHOLE_CURRENCY', currency: 'USD', transactionType: 'WITHDRAWAL' }]);
     
        const resultOfSetting = await handler.setWithdrawalAmount(event);
        logger('Result of setting:', resultOfSetting);

        expect(resultOfSetting).to.deep.equal(expectedResult);
        expect(sumAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'USD');
        helper.expectNoCalls(redisGetStub, redisGetStub, lamdbaInvokeStub, getOwnerInfoForAccountStub, addTransactionToAccountStub);
    });

    it('Catches thrown errors', async () => {
        const event = helper.wrapEvent({ accountId: testAccountId, amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD' }, testUserId);

        sumAccountBalanceStub.resolves({ amount: 10, unit: 'HUNDREDTH_CENT', currency: 'USD', lastTxTime: null });
        fetchPendingTxStub.resolves([]);
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
        
        const newSumAccount = { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null }; // tx is not settled yet ...
        sumAccountBalanceStub.resolves(newSumAccount);
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ updatedTime: moment() });

        const testPublishContext = {
            context: {
                transactionId: testTransactionId,
                accountId: testAccountId,
                timeInMillis: testSettlementTime.valueOf(),
                withdrawalAmount: '100::HUNDREDTH_CENT::ZAR',
                newBalance: '100::HUNDREDTH_CENT::ZAR'
            }
        };

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: newSumAccount }) };

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

        const newSumAccount = { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null }; // tx is not settled yet ...
        sumAccountBalanceStub.resolves(newSumAccount);
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ updatedTime: moment() });

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: newSumAccount }) };

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
        const mockMoment = moment();
        momentStub.returns(mockMoment.clone());
        
        const newSumAccount = { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null }; // tx is not settled yet ...
        sumAccountBalanceStub.resolves(newSumAccount);
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ updatedTime: moment() });

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: newSumAccount }) };

        const confirmationResult = await handler.confirmWithdrawal(event);

        expect(confirmationResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWith(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.userBankVerify'), false, { operation: 'statusCheck', parameters: { jobId: 'KSDF382' }}));

        const expectedLogOptions = { context: { resultFromVerifier: { jobId: 'KSDF382', result: 'FAILED' } } };
        expect(publishEventStub).to.have.been.calledTwice; // otherwise is confirmation event
        expect(publishEventStub).to.have.been.calledWith(testUserId, 'BANK_VERIFICATION_FAILED', expectedLogOptions);

        const modifiedBankDetails = { ...testBankDetails };
        modifiedBankDetails.verificationStatus = 'FAILED';
        modifiedBankDetails.verificationTime = mockMoment.format('DD MMMM, YYYY');
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

        const newSumAccount = { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null }; // tx is not settled yet ...
        sumAccountBalanceStub.resolves(newSumAccount);
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ updatedTime: moment() });

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: newSumAccount }) };

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

        const newSumAccount = { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null }; // tx is not settled yet ...
        sumAccountBalanceStub.resolves(newSumAccount);
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ updatedTime: moment() });

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: newSumAccount }) };

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
        
        const newSumAccount = { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR', lastTxTime: null }; // tx is not settled yet ...
        sumAccountBalanceStub.resolves(newSumAccount);
        fetchTransactionStub.resolves(testTransaction);
        updateTxSettlementStatusStub.resolves({ updatedTime: moment() });

        const expectedResult = { statusCode: 200, body: JSON.stringify({ balance: newSumAccount }) };

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
