'use strict';

process.env.NODE_ENV = 'test';

// const logger = require('debug')('jupiter:save:completion-test');
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

const testAuthContext = {
    authorizer: {
        systemWideUserId: testUserId
    }
};

const testNumberOfSaves = 5;
const testBaseAmount = 1000000;
const testAmounts = Array(testNumberOfSaves).fill().map(() => Math.floor(Math.random() * testBaseAmount));
const sumOfTestAmounts = testAmounts.reduce((cum, value) => cum + value, 0);

const findFloatOrIdStub = sinon.stub();
const updateSaveRdsStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const countSettledSavesStub = sinon.stub();
const getAccountBalanceStub = sinon.stub();

const triggerTxStatusStub = sinon.stub();
const getPaymentStatusStub = sinon.stub();
const fetchClientFloatStub = sinon.stub();

const publishStub = sinon.stub();
const templateStub = sinon.stub();

const momentStub = sinon.stub();

const handler = proxyquire('../saving-handler', {
    './persistence/rds': { 
        'getOwnerInfoForAccount': findFloatOrIdStub, 
        'updateTxToSettled': updateSaveRdsStub,
        'fetchTransaction': fetchTransactionStub,
        'countSettledSaves': countSettledSavesStub,
        'sumAccountBalance': getAccountBalanceStub
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchClientFloatStub,
        '@noCallThru': true
    },
    './payment-link': {
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
        // since OZOW is often marking error results as cancelled, causing user confusion, we are just doubling those
        const resultTypes = ['SUCCESS', 'ERROR', 'ERROR'];
        
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
            });
        });

        expect(fetchTransactionStub).to.have.been.calledThrice;
    });

    // removing this until payment provider has not-sucky infra
    // it('Invokes transaction check lambda (on success)', async () => {
    //     const resultOfCall = await handler.completeSavingPaymentFlow({
    //         pathParameters: { proxy: `PROVIDER/${testPendingTxId}/SUCCESS` }
    //     });

    //     expect(resultOfCall).to.exist;
    //     expect(triggerTxStatusStub).to.have.been.calledOnceWithExactly({ 
    //         transactionId: testPendingTxId,
    //         paymentProvider: 'PROVIDER'
    //     });
    //     expect(fetchTransactionStub).to.have.been.calledWith(testPendingTxId);
    // });

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
        paymentProvider: 'OZOW',
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

    const wrapTestParams = (queryParams) => ({ httpMethod: 'GET', queryStringParameters: queryParams, requestContext: testAuthContext });

    beforeEach(() => testHelper.resetStubs(getPaymentStatusStub, updateSaveRdsStub, publishStub, fetchTransactionStub, countSettledSavesStub, fetchClientFloatStub, momentStub));

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
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ paymentStatus: 'SETTLED' });
        updateSaveRdsStub.resolves(responseToTxUpdated);
        countSettledSavesStub.withArgs(testAccountId).resolves(5);
        momentStub.returns(testSettlementTime);

        const paymentCheckSuccessResult = await handler.checkPendingPayment({ transactionId: testPendingTxId });
        
        expect(paymentCheckSuccessResult).to.have.property('statusCode', 200);
        expect(paymentCheckSuccessResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckSuccessResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);
        
        expect(publishStub).to.have.been.calledTwice; // todo : add expectations for what is published
        expect(updateSaveRdsStub).to.have.been.calledOnceWithExactly({ transactionId: testPendingTxId, settlementTime: testSettlementTime, settlingUserId: testUserId });
        expect(fetchTransactionStub).to.have.been.calledTwice;
        expect(fetchTransactionStub).to.have.been.calledWith(testPendingTxId);
        expect(countSettledSavesStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(momentStub).to.have.been.called;
    });

    it('Includes tags in payment result (e.g., for savings pots/pools)', async () => {
        const mockTags = [`FRIEND_SAVING_POT::${uuid()}`];
        const expectedResult = { ...responseToTxUpdated, result: 'PAYMENT_SUCCEEDED', tags: mockTags };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING', tags: mockTags };

        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        findFloatOrIdStub.withArgs(testAccountId).resolves({ systemWideUserId: testUserId });
        
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ paymentStatus: 'SETTLED' });
        
        updateSaveRdsStub.resolves(responseToTxUpdated);
        countSettledSavesStub.withArgs(testAccountId).resolves(5);
        momentStub.returns(testSettlementTime);

        // most expectations already covered above, so just covering increment here
        const paymentCheckSuccessResult = await handler.checkPendingPayment({ transactionId: testPendingTxId });
        
        const resultOfCheck = JSON.parse(paymentCheckSuccessResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);
    });

    it('Fails on missing authorization', async () => {
        const result = await handler.checkPendingPayment({ httpMethod: 'GET', queryStringParameters: { transactionId: testPendingTxId }});
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(403);
        expect(result.message).to.deep.equal('User ID not found in context');
    });

    it('Handles failed payments properly, with inclusion of bank details', async () => {
        const expectedBankDetails = {
            bankName: 'JPM',
            accountType: 'Cheque',
            accountNumber: '123456',
            branchCode: '343677',
            beneficiaryName: 'Jupiter Savings'
        };

        const expectedResult = { 
            result: 'PAYMENT_FAILED',
            messageToUser: 'Sorry the payment failed. Please contact your bank or contact support and quote reference TUSER170001',
            bankDetails: { ...expectedBankDetails, useReference: 'TUSER170001' }
        };

        const testEvent = { transactionId: testPendingTxId };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING', humanReference: 'TUSER170001' };
        
        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ result: 'ERROR' });
        fetchClientFloatStub.resolves({ bankDetails: expectedBankDetails });

        const paymentCheckFailureResult = await handler.checkPendingPayment(wrapTestParams(testEvent));
        
        expect(paymentCheckFailureResult).to.exist;
        expect(paymentCheckFailureResult).to.have.property('statusCode', 200);
        expect(paymentCheckFailureResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckFailureResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);

        expect(fetchClientFloatStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
    });

    it('Handles pending payments properly, if Ozow', async () => {
        const expectedBankDetails = {
            bankName: 'JPM',
            accountType: 'Cheque',
            accountNumber: '123456',
            routingNumber: '343677',
            beneficiaryName: 'Jupiter Savings'
        };

        const expectedEvent = { transactionId: testPendingTxId };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING', humanReference: 'TUSER170001' };        

        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ result: 'PENDING' });
        fetchClientFloatStub.resolves({ bankDetails: expectedBankDetails });
        
        const paymentCheckPendingResult = await handler.checkPendingPayment(wrapTestParams(expectedEvent));
        expect(paymentCheckPendingResult).to.exist;
        expect(paymentCheckPendingResult).to.have.property('statusCode', 200);
        expect(paymentCheckPendingResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckPendingResult.body);
        expect(resultOfCheck).to.deep.equal({ 
            result: 'PAYMENT_PENDING', 
            bankDetails: { ...expectedBankDetails, useReference: 'TUSER170001' } 
        });

        expect(getPaymentStatusStub).to.have.been.calledOnce;
        expect(fetchClientFloatStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
    });

    it('Does not check Ozow, but just returns, if manual EFT', async () => {
        const expectedBankDetails = {
            bankName: 'JPM',
            accountType: 'Cheque',
            accountNumber: '123456',
            routingNumber: '343677',
            beneficiaryName: 'Jupiter Savings'
        };

        const manualTx = { ...testTransaction, settlementStatus: 'PENDING', humanReference: 'TUSER1700001' };
        manualTx.paymentProvider = 'MANUAL_EFT';

        fetchTransactionStub.withArgs(testPendingTxId).resolves(manualTx);
        fetchClientFloatStub.resolves({ bankDetails: expectedBankDetails });

        const expectedEvent = { transactionId: testPendingTxId };
        const paymentCheckPendingResult = await handler.checkPendingPayment(wrapTestParams(expectedEvent));

        const paymentCheckBody = testHelper.standardOkayChecks(paymentCheckPendingResult);
        expect(paymentCheckBody).to.deep.equal({
            result: 'PAYMENT_PENDING', bankDetails: { ...expectedBankDetails, useReference: 'TUSER1700001' }
        });
        expect(getPaymentStatusStub).to.not.have.been.called;
    });

    it('Handles non-standard payment responses', async () => {
        const expectedBankDetails = {
            bankName: 'JPM',
            accountType: 'Cheque',
            accountNumber: '123456',
            routingNumber: '343677',
            beneficiaryName: 'Jupiter Savings'
        };

        const expectedEvent = { transactionId: testPendingTxId };
        const dummyTx = { ...testTransaction, settlementStatus: 'PENDING', humanReference: 'TUSER170001' };        

        fetchTransactionStub.withArgs(testPendingTxId).resolves(dummyTx);
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ result: 'UNKNOWN' });
        fetchClientFloatStub.resolves({ bankDetails: expectedBankDetails });
        
        const paymentCheckPendingResult = await handler.checkPendingPayment(wrapTestParams(expectedEvent));
        expect(paymentCheckPendingResult).to.exist;
        expect(paymentCheckPendingResult).to.have.property('statusCode', 200);
        expect(paymentCheckPendingResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckPendingResult.body);
        expect(resultOfCheck).to.deep.equal({ 
            result: 'PAYMENT_PENDING', 
            bankDetails: { ...expectedBankDetails, useReference: 'TUSER170001' } 
        });

        expect(fetchClientFloatStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
    });

    it('Handles warmup call', async () => {        
        const warmupResult = await handler.checkPendingPayment({});
        expect(warmupResult).to.exist;
        expect(warmupResult).to.have.property('statusCode', 400);
        expect(warmupResult).to.have.property('body', 'Empty invocation');
    });

    it('Catches thrown errors', async () => {
        const paymentCheckErrorResult = await handler.checkPendingPayment(wrapTestParams({ transactionId: testPendingTxId }));
        
        expect(paymentCheckErrorResult).to.deep.equal({ statusCode: 500, body: JSON.stringify(`Cannot read property 'settlementStatus' of undefined`) });
        expect(fetchTransactionStub).to.have.been.calledOnce;
        testHelper.expectNoCalls(publishStub, getPaymentStatusStub, updateSaveRdsStub, countSettledSavesStub, momentStub);
    });

});


describe('*** UNIT TEST TRANSACTION SETTLEMENT ***', async () => {

    const testSettlementTime = moment();
    const testfloatAdditionTxId = uuid();
    const testFloatAllocTxId = uuid();
    const testPendingTxId = uuid();

    const testSettleInfo = {
        transactionId: testPendingTxId,
        settlingUserId: testUserId,
        settlementTimeEpochMillis: testSettlementTime.valueOf()
    };

    const mockNewBalance = { amount: sumOfTestAmounts, unit: 'HUNDREDTH_CENT' }; 

    const responseToTxUpdated = {
        transactionDetails: [
            { accountTransactionId: testPendingTxId, updatedTime: moment().format() }, 
            { floatAdditionTransactionId: testfloatAdditionTxId, creationTime: moment().format() },
            { floatAllocationTransactionId: testFloatAllocTxId, creationTime: moment().format() }
        ],
        newBalance: mockNewBalance
    };

    beforeEach(() => testHelper.resetStubs(getPaymentStatusStub, updateSaveRdsStub, publishStub, fetchTransactionStub, countSettledSavesStub, fetchClientFloatStub, momentStub));

    it('Updates transaction to settled', async () => {
        updateSaveRdsStub.resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const testEvent = { ...testSettleInfo };

        const resultOfSettle = await handler.settle(testEvent);
        expect(resultOfSettle).to.exist;
        expect(resultOfSettle).to.deep.equal(responseToTxUpdated);
        expect(updateSaveRdsStub).to.have.been.calledOnceWithExactly({ transactionId: testPendingTxId, settlementTime: testSettlementTime, settlingUserId: testUserId });
    });

    it('Uodates settlement time', async () => {
        updateSaveRdsStub.resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const testEvent = { ...testSettleInfo };
        Reflect.deleteProperty(testEvent, 'settlementTimeEpochMillis');

        const resultOfSettle = await handler.settle(testEvent);
        expect(resultOfSettle).to.exist;
        expect(resultOfSettle).to.deep.equal(responseToTxUpdated);
        expect(updateSaveRdsStub).to.have.been.calledOnceWithExactly({ transactionId: testPendingTxId, settlementTime: testSettlementTime, settlingUserId: testUserId });
    });

    it('Fails on missing transaction id', async () => {
        updateSaveRdsStub.resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const testEvent = { ...testSettleInfo };
        Reflect.deleteProperty(testEvent, 'transactionId');

        const resultOfSettle = await handler.settle(testEvent);
        expect(resultOfSettle).to.exist;
        expect(resultOfSettle).to.deep.equal({ statusCode: 400, body: 'Error! No transaction ID provided' });
        expect(updateSaveRdsStub).to.have.not.been.called;
    });

    it('Fails on missing settling user id', async () => {
        updateSaveRdsStub.resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const testEvent = { ...testSettleInfo };
        Reflect.deleteProperty(testEvent, 'settlingUserId');

        const resultOfSettle = await handler.settle(testEvent);
        expect(resultOfSettle).to.exist;
        expect(resultOfSettle).to.deep.equal({ statusCode: 400, body: 'Error! No settling user ID provided' });
        expect(updateSaveRdsStub).to.have.not.been.called;
    });

});
