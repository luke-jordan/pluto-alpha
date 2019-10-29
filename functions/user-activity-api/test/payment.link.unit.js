'use strict';

const logger = require('debug')('jupiter:payment-link:test');
const config = require('config');
const uuid = require('uuid');
const moment = require('moment');

const testHelper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');

const lambdaStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lambdaStub;
    }
}

const paymentLinkHandler = proxyquire('../payment-link', {
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }  
});

describe('*** UNIT TESTING PAYMENT LAMBDAS INVOCATION ***', () => {
    
    const testSaveNumber = 10;
    const testAmountWhole = 100;
    const testAmountBp = 100 * 100 * 100; // hundredths of a cent
    
    const testTxId = uuid();
    const testReqId = uuid();

    beforeEach(() => {
        lambdaStub.reset();
    });

    it('Generate payment references, properly', async () => {
        const testStems = ['LJORDAN1', 'ABRIJMOHUN12', 'BNDLOVU102', 'BAJIBAWO1002'];
        const testNumberSaves = [104, 2045, 1, 4095];
        const expectedRef = ['LJORDAN1-00104', 'ABRIJMOHUN12-02045', 'BNDLOVU102-00001', 'BAJIBAWO1002-04095'];

        testStems.forEach((stem, idx) => {
            const assembledRef = paymentLinkHandler.generateBankRef({ bankRefStem: stem, priorSaveCount: testNumberSaves[idx] });
            logger('Assembled: ', assembledRef);
            expect(assembledRef).to.equal(expectedRef[idx]);
        });
    });

    it('Get a payment link, happy path', async () => {
        
        const linkRequest = {
            transactionId: testTxId,
            amountDict: {
                currency: 'ZAR',
                unit: 'HUNDREDTH_CENT',
                amount: testAmountBp
            },
            accountInfo: {
                bankRefStem: 'LJORDAN1',
                priorSaveCount: testSaveNumber
            }
        };

        // tested above, so no need here
        const expectedBankRef = paymentLinkHandler.generateBankRef(linkRequest.accountInfo);

        const expectedLamdbaInvokeBody = {
            countryCode: 'ZA',
            currencyCode: 'ZAR',
            amount: testAmountWhole,
            transactionId: testTxId,
            bankReference: expectedBankRef,
            isTest: true
        };

        const mockLambdaPayload = {
            result: 'PAYMENT_INITIATED',
            paymentUrl: 'https://pay.me/1234',
            requestId: testReqId
        };

        lambdaStub.returns({ promise: () => testHelper.mockLambdaResponse(mockLambdaPayload) });
        const paymentLink = await paymentLinkHandler.getPaymentLink(linkRequest);

        expect(paymentLink).to.exist;
        expect(paymentLink).to.deep.equal(mockLambdaPayload);

        const expectedLambdaInvoke = testHelper.wrapLambdaInvoc(config.get('lambdas.paymentUrlGet'), false, expectedLamdbaInvokeBody);
        testHelper.testLambdaInvoke(lambdaStub, expectedLambdaInvoke);
    });

    it('Check payment status, happy path', async () => {
        const testCreatedDate = moment().subtract(30, 'seconds');
        const testPaymentDate = moment();
        
        const statusRequest = {
            transactionId: testTxId
        };

        const expectedInvokeBody = {
            transactionId: testTxId,
            isTest: true
        };

        const mockLambdaPayload = {
            result: 'COMPLETED',
            createdDate: testCreatedDate.format(),
            paymentDate: testPaymentDate.format()
        };

        lambdaStub.returns({ promise: () => testHelper.mockLambdaResponse(mockLambdaPayload) });
        const paymentResult = await paymentLinkHandler.checkPayment(statusRequest);

        expect(paymentResult).to.exist;
        expect(paymentResult).to.deep.equal({
            paymentStatus: 'SETTLED',
            createdDate: moment(testCreatedDate.format()),
            paymentDate: moment(testPaymentDate.format())
        });

        const expectedInvocation = testHelper.wrapLambdaInvoc(config.get('lambdas.paymentStatusCheck'), false, expectedInvokeBody);
        testHelper.testLambdaInvoke(lambdaStub, expectedInvocation);
    });

    it('Warmup payment lambda', async () => {
        const expectedInvocation = testHelper.wrapLambdaInvoc(config.get('lambdas.paymentUrlGet'), true, {});
        lambdaStub.returns({ promise: () => ({ StatusCode: 202 }) });
        
        const resultOfWarmup = await paymentLinkHandler.warmUpPayment();
        expect(resultOfWarmup).to.deep.equal({ result: 'TRIGGERED' });
        testHelper.testLambdaInvoke(lambdaStub, expectedInvocation);
    });

});
