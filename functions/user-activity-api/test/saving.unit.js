'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:save:test');
const config = require('config');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const moment = require('moment');
const testHelper = require('./test.helper');

const testAccountId = uuid();
const testUserId = uuid();
const testClientId = 'some_savings_co';
const testFloatId = 'usd_primary_float';
const testPaymentRef = 'some_ref_at_bank';

const testAuthContext = {
    authorizer: {
        systemWideUserId: testUserId
    }
};

const testSettlementTimeSeconds = 10;
const testTimeInitiated = moment().subtract(testSettlementTimeSeconds, 'seconds');
const testTimeSettled = moment();

const testNumberOfSaves = 5;
const testBaseAmount = 1000000;
const testAmounts = Array(testNumberOfSaves).fill().map(() => Math.floor(Math.random() * testBaseAmount));
const sumOfTestAmounts = testAmounts.reduce((cum, value) => cum + value, 0);
logger('Setting up, test amounts: ', testAmounts, ' with sum: ', sumOfTestAmounts);

const findMatchingTxStub = sinon.stub();
const findFloatOrIdStub = sinon.stub();
const addSavingsRdsStub = sinon.stub();
const updateSaveRdsStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const countSettledSavesStub = sinon.stub();
const getAccountBalanceStub = sinon.stub();

const fetchBankRefStub = sinon.stub();
const getPaymentUrlStub = sinon.stub();
const triggerTxStatusStub = sinon.stub();
const getPaymentStatusStub = sinon.stub();

const publishStub = sinon.stub();
const templateStub = sinon.stub();

const momentStub = sinon.stub();

const handler = proxyquire('../saving-handler', {
    './persistence/rds': { 
        'findMatchingTransaction': findMatchingTxStub,
        'getOwnerInfoForAccount': findFloatOrIdStub, 
        'addSavingToTransactions': addSavingsRdsStub,
        'updateSaveTxToSettled': updateSaveRdsStub,
        'fetchTransaction': fetchTransactionStub,
        'countSettledSaves': countSettledSavesStub,
        'fetchInfoForBankRef': fetchBankRefStub,
        'sumAccountBalance': getAccountBalanceStub
    },
    './payment-link': {
        'getPaymentLink': getPaymentUrlStub,
        'triggerTxStatusCheck': triggerTxStatusStub,
        'checkPayment': getPaymentStatusStub,
        'warmUpPayment': sinon.stub() // storing/inspecting would add clutter for no robustness
    },
    'publish-common': {
        'publishUserEvent': publishStub,
        'obtainTemplate': templateStub
    },
    'moment-timezone': momentStub
});

const resetStubHistory = () => {
    findMatchingTxStub.resetHistory();
    findFloatOrIdStub.resetHistory();
    addSavingsRdsStub.resetHistory();
    updateSaveRdsStub.reset();
    fetchTransactionStub.reset();
    countSettledSavesStub.reset();
    publishStub.reset();
    momentStub.reset();
    momentStub.callsFake(moment); // as with uuid in RDS, too much time being sunk into test framework's design flaws, so a work around here
};

describe('*** USER ACTIVITY *** UNIT TEST SAVING *** User saves, without reward, sync or async', () => {

    const testTransactionId = uuid();

    const testSaveSettlementBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        initiationTimeEpochMillis: testTimeInitiated.valueOf(),
        settlementTimeEpochMillis: testTimeSettled.valueOf(),
        settlementStatus: 'SETTLED',
        amount: amount,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        floatId: testFloatId,
        clientId: testClientId,
        paymentRef: testPaymentRef,
        paymentProvider: 'STRIPE'
    });

    const testSavePendingBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        initiationTimeEpochMillis: testTimeInitiated.valueOf(),
        settlementStatus: 'INITIATED',
        amount: amount,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT'
    });

    const wrapTestEvent = (eventBody) => ({ body: JSON.stringify(eventBody), requestContext: testAuthContext });

    const wellFormedMinimalSettledRequestToRds = {
        accountId: testAccountId,
        initiationTime: testHelper.momentMatcher(testTimeInitiated),
        settlementTime: testHelper.momentMatcher(testTimeSettled),
        settlementStatus: 'SETTLED',
        amount: sinon.match.number,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        floatId: testFloatId,
        clientId: testClientId,
        paymentRef: testPaymentRef,
        paymentProvider: 'STRIPE'
    };

    const wellFormedMinimalPendingRequestToRds = {
        accountId: testAccountId,
        initiationTime: testHelper.momentMatcher(testTimeInitiated),
        settlementStatus: 'INITIATED',
        amount: sinon.match.number,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        clientId: testClientId,
        floatId: testFloatId
    };
    
    const responseToTxSettled = {
        transactionDetails: [{ accountTransactionId: testTransactionId, creationTime: moment().format() }, 
            { floatAdditionTransactionId: uuid(), creationTime: moment().format() },
            { floatAllocationTransactionId: uuid(), creationTime: moment().format() }],
        newBalance: { amount: sumOfTestAmounts, unit: 'HUNDREDTH_CENT' }
    };

    const responseToTxPending = {
        transactionDetails: [{ accountTransactionId: testTransactionId, persistedTimeEpochMillis: moment().format() }]
    };

    const testBankRefInfo = { humanRef: 'JUPSAVER', count: 10 };
    const expectedPaymentInfo = {
        transactionId: testTransactionId,
        accountInfo: { bankRefStem: 'JUPSAVER', priorSaveCount: 10 },
        amountDict: { amount: testAmounts[0], currency: 'USD', unit: 'HUNDREDTH_CENT' }
    };

    before(() => {
        findFloatOrIdStub.withArgs(testAccountId).resolves({ clientId: testClientId, floatId: testFloatId });
        addSavingsRdsStub.withArgs(sinon.match(wellFormedMinimalSettledRequestToRds)).resolves(responseToTxSettled);
        addSavingsRdsStub.withArgs(wellFormedMinimalPendingRequestToRds).resolves(responseToTxPending);
    });

    beforeEach(() => resetStubHistory());

    it('Fails gracefully, RDS failure', async () => {
        const badEvent = { ...testSavePendingBase() };
        badEvent.accountId = 'hello-blah-wrong';
        badEvent.clientId = testClientId;
        badEvent.floatId = testFloatId;

        const badRdsRequest = { ...wellFormedMinimalPendingRequestToRds };
        badRdsRequest.accountId = 'hello-blah-wrong';
        badRdsRequest.amount = badEvent.amount;
        badRdsRequest.initiationTime = testHelper.momentMatcher(testTimeInitiated);
        
        addSavingsRdsStub.withArgs(badRdsRequest).rejects(new Error('Error! Bad account ID'));
        
        const expectedError2 = await handler.initiatePendingSave({ body: JSON.stringify(badEvent), requestContext: testAuthContext });
        // testHelper.logNestedMatches(badRdsRequest, addSavingsRdsStub.getCall(0).args[0]);
        
        expect(expectedError2).to.exist;
        expect(expectedError2).to.have.property('statusCode', 500);
        expect(expectedError2).to.have.property('body', JSON.stringify('Error! Bad account ID')); // in case something puts a dict in error msg
    });

    it('Warmup handled gracefully', async () => {
        const expectedWarmupResponse = await handler.initiatePendingSave({});
        expect(expectedWarmupResponse).to.exist;
        expect(expectedWarmupResponse).to.have.property('statusCode', 400);
        expect(expectedWarmupResponse).to.have.property('body', 'Empty invocation');
    });

    it('Most common route, initiated payment, works as wrapper, happy path', async () => {
        const saveEventToWrapper = testSavePendingBase();
        Reflect.deleteProperty(saveEventToWrapper, 'settlementStatus');
        Reflect.deleteProperty(saveEventToWrapper, 'initiationTimeEpochMillis');
        momentStub.returns(testTimeInitiated);

        fetchBankRefStub.resolves(testBankRefInfo);
        getPaymentUrlStub.resolves({ paymentUrl: 'https://pay.me/1234 '});
        
        const apiGwMock = { body: JSON.stringify(saveEventToWrapper), requestContext: testAuthContext };
        const resultOfWrapperCall = await handler.initiatePendingSave(apiGwMock);
        logger('Received: ', resultOfWrapperCall);
        const saveBody = testHelper.standardOkayChecks(resultOfWrapperCall);
        expect(saveBody).to.deep.equal(responseToTxPending);

        expect(fetchBankRefStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(getPaymentUrlStub).to.have.been.calledOnceWithExactly(expectedPaymentInfo);
    });

    it('Wrapper fails if no auth context', async () => {
        const noAuthEvent = { body: JSON.stringify(testSavePendingBase()), requestContext: { }};
        const resultOfCallWithNoContext = await handler.initiatePendingSave(noAuthEvent);
        expect(resultOfCallWithNoContext).to.exist;
        expect(resultOfCallWithNoContext).to.have.property('statusCode', 403);
    });
        
    it('Stores pending, if no payment information', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        
        logger('Well formed request: ', wellFormedMinimalPendingRequestToRds);

        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxPending);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalPendingRequestToRds);
        expect(findFloatOrIdStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    it('Stores pending, if given client and float too', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        saveEvent.floatId = testFloatId;
        saveEvent.clientId = testClientId;

        logger('Well formed request: ', wellFormedMinimalPendingRequestToRds);

        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxPending);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalPendingRequestToRds);
        expect(findFloatOrIdStub).to.not.have.been.called;
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    it('Throws an error when no account information, currency, unit or amount provided', async () => {
        const saveEventNoAccountId = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAccountId, 'accountId');
        const saveEventNoAmount = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAmount, 'amount');
        const saveEventNoCurrency = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoCurrency, 'currency');
        const saveEventNoUnit = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoUnit, 'unit');

        const expectedNoAccountError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoAccountId));
        testHelper.checkErrorResultForMsg(expectedNoAccountError, 'Error! No account ID provided for the save');

        const expectedNoAmountError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoAmount));
        const expectedNoCurrencyError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoCurrency));
        const expectedNoUnitError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoUnit));

        testHelper.checkErrorResultForMsg(expectedNoAmountError, 'Error! No amount provided for the save');
        testHelper.checkErrorResultForMsg(expectedNoCurrencyError, 'Error! No currency specified for the saving event');
        testHelper.checkErrorResultForMsg(expectedNoUnitError, 'Error! No unit specified for the saving event');
    });
    
});

describe('*** UNIT TESTING PAYMENT COMPLETE PAGES ***', () => {

    const testPendingTxId = uuid();

    const successTemplateKey = `payment/${config.get('templates.payment.success')}`;
    const expectedHeader = { 'Content-Type': 'text/html' };

    beforeEach(() => testHelper.resetStubs(templateStub, triggerTxStatusStub));
    
    it('Handles warmup properly', async () => {
        const warmupResult = await handler.completeSavingPaymentFlow({});
        expect(warmupResult).to.deep.equal({ statusCode: 400, body: 'Empty invocation' });
        expect(templateStub).to.have.been.calledOnceWithExactly(successTemplateKey);
    });

    it('Swallows error gracefully, showing an error page', async () => {
        const updateErrorResult = await handler.completeSavingPaymentFlow({ pathParameters: 'bad-path' });
        expect(updateErrorResult).to.exist;
        expect(updateErrorResult).to.have.property('statusCode', 500);
        expect(updateErrorResult).to.have.property('headers');
        expect(updateErrorResult.headers).to.deep.equal(expectedHeader);
        expect(updateErrorResult).to.have.property('body');
    });

    it('Maps results to correct pages', async () => {
        const resultTypes = ['SUCCESS', 'ERROR', 'CANCELLED'];
        
        const mapPathParams = (result) => ({ 
            pathParameters: { proxy: `PROVIDER/${testPendingTxId}/${result}` } 
        });
        const resultEvents = resultTypes.map(mapPathParams);
        
        fetchTransactionStub.withArgs(testPendingTxId).resolves({ transactionId: testPendingTxId });
        resultTypes.forEach((type) => {
            templateStub.withArgs(`payment/${config.get(`templates.payment.${type.toLowerCase()}`)}`).resolves(`<html>${type}</html>`);
        });

        const results = await Promise.all(resultEvents.map((event) => handler.completeSavingPaymentFlow(event)));
        results.forEach((result, idx) => {
            expect(result).to.exist;
            expect(result).to.deep.equal({
                statusCode: 200,
                headers: expectedHeader,
                body: `<html>${resultTypes[idx]}</html>`
            })
        });

        expect(fetchTransactionStub).to.have.been.calledThrice;
    });

    it('Invokes transaction check lambda (on success)', async () => {
        const resultOfCall = await handler.completeSavingPaymentFlow({
            pathParameters: { proxy: `PROVIDER/${testPendingTxId}/SUCCESS` }
        });

        expect(resultOfCall).to.exist;
        expect(triggerTxStatusStub).to.have.been.calledOnceWithExactly({ 
            transactionId: testPendingTxId,
            paymentProvider: 'PROVIDER'
        });
        expect(fetchTransactionStub).to.have.been.calledWith(testPendingTxId);
    });

    it('Rejects unknown result type', async () => {
        const result = await handler.completeSavingPaymentFlow({
            pathParameters: { proxy: `PROVIDER/${testPendingTxId}/SOMETHINGOROTHER` }
        });

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 500);
        expect(templateStub).to.not.have.been.called;
        expect(triggerTxStatusStub).to.not.have.been.called;
    });

    it('Rejects unknown transaction ID', async () => {
        const result = await handler.completeSavingPaymentFlow({
            pathParameters: { proxy: `PROVIDER/some-bad-id/SUCCESS` }
        });

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 500);
        expect(templateStub).to.not.have.been.called;
        expect(triggerTxStatusStub).to.not.have.been.called;
    });

});

describe('*** UNIT TESTING CHECK PENDING PAYMENT ****', () => {

    const testPendingTxId = uuid();
    const testSettlementTime = moment();

    const testTxId = uuid();
    const testSaveAmount = 1000;
    
    const testTransaction = {
        accountTransactionId: testTxId,
        accountId: testAccountId,
        currency: 'ZAR',
        unit: 'HUNDREDTH_CENT',
        amount: testSaveAmount,
        floatId: testFloatId,
        clientId: testClientId,
        settlementStatus: 'SETTLED',
        initiationTime: moment().subtract(5, 'minutes').format(),
        settlementTime: testSettlementTime
    };

    const mockNewBalance = { amount: sumOfTestAmounts, unit: 'HUNDREDTH_CENT' }; 
    const responseToTxUpdated = {
        transactionDetails: [
            { accountTransactionId: testPendingTxId, updatedTime: moment().format() }, 
            { floatAdditionTransactionId: uuid(), creationTime: moment().format() },
            { floatAllocationTransactionId: uuid(), creationTime: moment().format() }
        ],
        newBalance: mockNewBalance
    };

    const wrapTestParams = (queryParams) => ({ queryStringParameters: queryParams, requestContext: testAuthContext });

    beforeEach(() => testHelper.resetStubs(getPaymentStatusStub, updateSaveRdsStub, publishStub, fetchTransactionStub, countSettledSavesStub, momentStub));

    it('Returns immediately if payment status is settled', async () => {
        fetchTransactionStub.withArgs(testPendingTxId).resolves(testTransaction);
        getAccountBalanceStub.resolves(mockNewBalance);
        momentStub.returns(testSettlementTime);
        
        const paymentCheckSuccessResult = await handler.checkPendingPayment(wrapTestParams({ transactionId: testPendingTxId }));
        
        expect(paymentCheckSuccessResult).to.exist;
        expect(paymentCheckSuccessResult).to.deep.equal({ 
            statusCode: 200,
            body: JSON.stringify({ result: 'PAYMENT_SUCCEEDED', newBalance: mockNewBalance }) 
        });
        
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(testPendingTxId);
        expect(getAccountBalanceStub).to.have.been.calledOnceWithExactly(testAccountId, 'ZAR', testSettlementTime);
    });

    it('Check for payment and settles if payment has been successful but was not settled before', async () => {
        const expectedResult = { ...responseToTxUpdated, result: 'PAYMENT_SUCCEEDED' };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING' };

        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        findFloatOrIdStub.withArgs(testAccountId).resolves({ systemWideUserId: testUserId });
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ result: 'SETTLED' });
        updateSaveRdsStub.resolves(responseToTxUpdated);
        countSettledSavesStub.withArgs(testAccountId).resolves(5);
        momentStub.returns(testSettlementTime);

        const paymentCheckSuccessResult = await handler.checkPendingPayment({ transactionId: testPendingTxId });
        
        expect(paymentCheckSuccessResult).to.have.property('statusCode', 200);
        expect(paymentCheckSuccessResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckSuccessResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);
        
        expect(publishStub).to.have.been.calledTwice;
        expect(updateSaveRdsStub).to.have.been.calledOnceWithExactly(testPendingTxId, testSettlementTime);
        expect(fetchTransactionStub).to.have.been.calledTwice;
        expect(fetchTransactionStub).to.have.been.calledWith(testPendingTxId);
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(momentStub).to.have.been.called;
    });

    it('Fails on missing authorization', async () => {
        const result = await handler.checkPendingPayment({ httpMethod: 'GET', queryStringParameters: { transactionId: testPendingTxId }});
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(403);
        expect(result.message).to.deep.equal('User ID not found in context');
    });

    it('Handles failed payments properly', async () => {
        const expectedResult = { 
            messageToUser: 'Sorry the payment failed. Please contact your bank or contact support and quote reference ABC123',
            result: 'PAYMENT_FAILED'
        };
        const testEvent = { transactionId: testPendingTxId };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING' };
        
        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ result: 'ERROR' });

        const paymentCheckFailureResult = await handler.checkPendingPayment(wrapTestParams(testEvent));
        
        expect(paymentCheckFailureResult).to.exist;
        expect(paymentCheckFailureResult).to.have.property('statusCode', 200);
        expect(paymentCheckFailureResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckFailureResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);
    });

    it('Handles pending payments properly', async () => {
        const expectedEvent = { transactionId: testPendingTxId };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING' };        

        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ result: 'PENDING' });
        
        const paymentCheckPendingResult = await handler.checkPendingPayment(wrapTestParams(expectedEvent));
        expect(paymentCheckPendingResult).to.exist;
        expect(paymentCheckPendingResult).to.have.property('statusCode', 200);
        expect(paymentCheckPendingResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckPendingResult.body);
        expect(resultOfCheck).to.deep.equal({ result: 'PAYMENT_PENDING' });
    });

    it('Catches thrown errors', async () => {
        const paymentCheckErrorResult = await handler.checkPendingPayment(wrapTestParams({ transactionId: testPendingTxId }));
        
        expect(paymentCheckErrorResult).to.deep.equal({ statusCode: 500, body: JSON.stringify(`Cannot read property 'settlementStatus' of undefined`) });
        expect(fetchTransactionStub).to.have.been.calledOnce;
        testHelper.expectNoCalls(publishStub, getPaymentStatusStub, updateSaveRdsStub, countSettledSavesStub, momentStub);
    });

});
