'use strict';

const logger = require('debug')('jupiter:third-parties:payment-unit-test');
const config = require('config');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const requestStub = sinon.stub();
const uuidStub = sinon.stub();

const handler = proxyquire('../payment-handler', {
    'request-promise': requestStub,
    'uuid/v4': uuidStub
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};


describe('*** UNIT TEST PAYMENT HANDLER ***', () => {
    
    const mockPaymentEndpoint = '/3d0b3420-8595-40b6-ab87-38f4d476ca17/Secure';
    const mockPaymentUrl = config.get('ozow.endpoints.payment');
    const mockRequestId = uuid();
    const mockMinimalEvent = {
        amount: 156,
        transactionId: 'TEST_REFERENCE',
        bankReference: 'TEST_REFERENCE',
        isTest: false,
        siteCode: config.get('ozow.siteCode'),
        countryCode: 'ZA',
        currencyCode: 'ZAR'
    };

    beforeEach(() => {
        resetStubs(requestStub);
    });

    const commonExpectations = (result) => {
        expect(result).to.exist;
        expect(result).to.have.property('result', 'PAYMENT_INITIATED');
        expect(result).to.have.property('paymentUrl', `${mockPaymentUrl}${mockPaymentEndpoint}`);
        expect(result).to.have.property('requestId', mockRequestId);
        expect(result).to.have.property('paymentProvider', 'OZOW');
        expect(requestStub).to.have.been.calledOnce;
    };

    it('Gets payment url from third party', async () => {
        const mockPaymentResponse = {
            paymentRequestId: mockRequestId,
            url: `${mockPaymentUrl}${mockPaymentEndpoint}`,
            errorMessage: null
        };

        requestStub.resolves(mockPaymentResponse);
        const mockEvent = { ...mockMinimalEvent };

        const resultOfRequest = await handler.paymentUrlRequest(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        commonExpectations(resultOfRequest);
        resetStubs(requestStub);

        requestStub.resolves(mockPaymentResponse);
        mockEvent.cancelUrl = 'https://mock.cancel.url.com/';
        mockEvent.successUrl = 'https://mock.success.url.com/';
        mockEvent.errorUrl = 'https://mock.error.url.com/';

        const resultOfFullRequest = await handler.paymentUrlRequest(mockEvent);
        logger('Result of payment url extraction:', resultOfFullRequest);

        commonExpectations(resultOfFullRequest);
    });

    it('Handles warmup event', async () => {
        requestStub.resolves();
        const mockEvent = { };

        const resultOfWarmup = await handler.paymentUrlRequest(mockEvent);
        logger('Result of warmup call:', resultOfWarmup);

        expect(resultOfWarmup).to.exist;
        expect(resultOfWarmup).to.have.property('result', 'WARMUP_COMPLETE');
        
        const expectedRequestOptions = {
            method: 'GET',
            uri: config.get('ozow.endpoints.warmup'),
            body: {},
            headers: { Accept: 'application/json', ApiKey: config.get('ozow.apiKey') },
            json: true
        };
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestOptions);
    });

    it('Catches expected error during warm up', async () => {
        requestStub.throws(new Error('Expected error'));
        const mockEvent = { };

        const resultOfWarmup = await handler.paymentUrlRequest(mockEvent);
        logger('Result of warmup call:', resultOfWarmup);

        expect(resultOfWarmup).to.exist;
        expect(resultOfWarmup).to.have.property('result', 'WARMUP_COMPLETE');

        const expectedRequestOptions = {
            method: 'GET',
            uri: config.get('ozow.endpoints.warmup'),
            body: {},
            headers: { Accept: 'application/json', ApiKey: config.get('ozow.apiKey') },
            json: true
        };
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestOptions);
    });

    it('Handles dry run', async () => {
        uuidStub.returns(mockRequestId);
        const mockEvent = { dryRunFakeSuccess: true };

        const resultOfDryrun = await handler.paymentUrlRequest(mockEvent);
        logger('Result of dry run:', resultOfDryrun);

        expect(resultOfDryrun).to.exist;
        expect(resultOfDryrun).to.have.property('result', 'PAYMENT_INITIATED');
        expect(resultOfDryrun).to.have.property('paymentUrl', config.get('ozow.endpoints.dryRun'));
        expect(resultOfDryrun).to.have.property('requestId', mockRequestId);
        expect(requestStub).to.have.not.been.called;
    });

    it('Throws error on missing required properties', async () => {
        const mockEvent = { ...mockMinimalEvent };
        Reflect.deleteProperty(mockEvent, 'countryCode');

        const resultOfRequest = await handler.paymentUrlRequest(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('result', 'PAYMENT_FAILED'); // ultimately should return 400
        expect(resultOfRequest).to.have.property('details', 'Missing required property: countryCode');
        expect(requestStub).to.have.not.been.called;
    });

    it('Throws error on where error message detected in response', async () => {
        const mockPaymentResponse = {
            paymentRequestId: null,
            url: null,
            errorMessage: 'The hash check has failed'
        };
    
        requestStub.resolves(mockPaymentResponse);
        const mockEvent = { ...mockMinimalEvent };

        const resultOfRequest = await handler.paymentUrlRequest(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('result', 'PAYMENT_FAILED');
        expect(resultOfRequest).to.have.property('details', 'The hash check has failed');
        expect(requestStub).to.have.been.calledOnce;
    });

    it('Throws an error one non-object response', async () => {
        requestStub.resolves('ERROR');
        const mockEvent = { ...mockMinimalEvent };

        const resultOfRequest = await handler.paymentUrlRequest(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('result', 'PAYMENT_FAILED');
        expect(resultOfRequest).to.have.property('details', 'Unexpected response from third party: ERROR');
        expect(requestStub).to.have.been.calledOnce;
    });

});


describe('*** UNIT TEST TRANSACTION STATUS HANDLER ***', () => {

    const mockTransactionReference = 'TEST_REFERENCE';
    const mockTransactionStatus = {
        merchantCode: 'TestMerch',
        siteCode: config.get('ozow.siteCode'),
        transactionId: mockTransactionReference,
        currencyCode: 'ZAR',
        amount: 10,
        status: 'Complete',
        statusMessage: 'Test transaction completed',
        subStatus: null,
        createdDate: '2019-09-11T13:14:21.807',
        paymentDate: '0001-01-01T00:00:00'
    };

    beforeEach(() => {
        resetStubs(requestStub);
    });

    it('Gets transaction status', async () => {
        requestStub.resolves([mockTransactionStatus, mockTransactionStatus, mockTransactionStatus]);
        const mockEvent = { transactionId: mockTransactionReference, isTest: true };

        const transactionStatus = await handler.statusCheck(mockEvent);
        logger('Transaction status result:', transactionStatus);

        expect(transactionStatus).to.exist;
        expect(transactionStatus).to.have.property('result', 'COMPLETE');
        expect(transactionStatus).to.have.property('createdDate', mockTransactionStatus.createdDate);
        expect(transactionStatus).to.have.property('paymentDate', mockTransactionStatus.paymentDate);

        const expectedRequestOptions = {
            method: 'GET',
            uri: config.get('ozow.endpoints.transactionStatus'),
            qs: {
                SiteCode: config.get('ozow.siteCode'),
                IsTest: true,
                TransactionReference: mockTransactionReference
            },
            headers: {
                ApiKey: config.get('ozow.apiKey'),
                Accept: 'application/json'
            },
            json: true
        };
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestOptions);
    });

    it('Sets test to false when false', async () => {
        requestStub.resolves([mockTransactionStatus, mockTransactionStatus, mockTransactionStatus]);
        const mockEvent = { transactionId: mockTransactionReference, isTest: false };

        const transactionStatus = await handler.statusCheck(mockEvent);
        logger('Transaction status result:', transactionStatus);

        // rest is tested up above
        expect(transactionStatus).to.exist;
        expect(transactionStatus).to.have.property('result', 'COMPLETE');

        const expectedRequestOptions = {
            method: 'GET',
            uri: config.get('ozow.endpoints.transactionStatus'),
            qs: {
                SiteCode: config.get('ozow.siteCode'),
                IsTest: false,
                TransactionReference: mockTransactionReference
            },
            headers: {
                ApiKey: config.get('ozow.apiKey'),
                Accept: 'application/json'
            },
            json: true
        };
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestOptions);
    });

    it('Handles pending response', async () => {
        requestStub.throws(new Error('StatusCodeError: 404 - undefined'));
        const mockEvent = { transactionId: mockTransactionReference, isTest: true };

        const transactionStatus = await handler.statusCheck(mockEvent);
        logger('Transaction status result:', transactionStatus);

        expect(transactionStatus).to.exist;
        expect(transactionStatus).to.have.property('result', 'PENDING');
       
        const expectedRequestOptions = {
            method: 'GET',
            uri: config.get('ozow.endpoints.transactionStatus'),
            qs: {
                SiteCode: config.get('ozow.siteCode'),
                IsTest: true,
                TransactionReference: mockTransactionReference
            },
            headers: {
                ApiKey: config.get('ozow.apiKey'),
                Accept: 'application/json'
            },
            json: true
        };
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestOptions);
        resetStubs(requestStub);

        requestStub.throws(new Error('404 -undefined'));

        const secondTransactionStatus = await handler.statusCheck(mockEvent);

        logger('Transaction status result:', secondTransactionStatus);

        expect(secondTransactionStatus).to.exist;
        expect(secondTransactionStatus).to.have.property('result', 'PENDING');
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestOptions);
    });

    it('Catches thrown errors', async () => {
        requestStub.throws(new Error('RequestError'));
        const mockEvent = { transactionId: mockTransactionReference };

        const transactionStatus = await handler.statusCheck(mockEvent);
        logger('Transaction status result on error:', transactionStatus);

        expect(transactionStatus).to.exist;
        expect(transactionStatus).to.have.property('result', 'ERROR');
        expect(transactionStatus).to.have.property('details', 'RequestError');
        expect(requestStub).to.have.been.calledOnce;
    });


    describe.skip('*** UNIT TEST HASH EVALUATOR ***', () => {

        const mockThirdPartyResponse = {
            CurrencyCode: 'ZAR',
            IsTest: false,
            StatusMessage: 'Transaction complete',
            SiteCode: config.get('ozow.siteCode'),
            TransactionId: 'TEST_ID',
            TransactionReference: 'TEST_REFERENCE',
            Amount: 10,
            Status: 'Abandoned',
            Hash: '78ba37f123005d09dc0c0dfea4ecc000e322ba579859545f95977576c6ff9f6d76d138e4128a9507a366bfdd28c41ecdb6e036d9a66dcf2ebab723642a320973'
        };

        it('Authenticates received response', async () => {
            requestStub.returns(mockThirdPartyResponse);

            const resultOfAuthentication = await handler.auth({});
            logger('Result of authentication:', resultOfAuthentication);
        });
    });

});
