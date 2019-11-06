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

const findMatchingTxStub = sinon.stub();
const findFloatOrIdStub = sinon.stub();
const updateSaveRdsStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const countSettledSavesStub = sinon.stub();
const getAccountBalanceStub = sinon.stub();

const triggerTxStatusStub = sinon.stub();
const getPaymentStatusStub = sinon.stub();

const publishStub = sinon.stub();
const templateStub = sinon.stub();

const momentStub = sinon.stub();

const handler = proxyquire('../saving-handler', {
    './persistence/rds': { 
        'findMatchingTransaction': findMatchingTxStub,
        'getOwnerInfoForAccount': findFloatOrIdStub, 
        'updateTxToSettled': updateSaveRdsStub,
        'fetchTransaction': fetchTransactionStub,
        'countSettledSaves': countSettledSavesStub,
        'sumAccountBalance': getAccountBalanceStub
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
            });
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

    const wrapTestParams = (queryParams) => ({ httpMethod: 'GET', queryStringParameters: queryParams, requestContext: testAuthContext });

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
        getPaymentStatusStub.withArgs({ transactionId: testPendingTxId }).resolves({ paymentStatus: 'SETTLED' });
        updateSaveRdsStub.resolves(responseToTxUpdated);
        countSettledSavesStub.withArgs(testAccountId).resolves(5);
        momentStub.returns(testSettlementTime);

        const paymentCheckSuccessResult = await handler.checkPendingPayment({ transactionId: testPendingTxId });
        
        expect(paymentCheckSuccessResult).to.have.property('statusCode', 200);
        expect(paymentCheckSuccessResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckSuccessResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);
        
        expect(publishStub).to.have.been.calledTwice;
        expect(updateSaveRdsStub).to.have.been.calledOnceWithExactly({ transactionId: testPendingTxId, settlementTime: testSettlementTime });
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
