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

const handler = proxyquire('../payment-handler', {
    'request-promise': requestStub,
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};


describe('*** UNIT TEST PAYMENT HANDLER ***', () => {
    
    const mockPaymentEndpoint = '/3d0b3420-8595-40b6-ab87-38f4d476ca17/Secure';
    const mockPaymentUrl = config.get('ozow.endpoints.payment');
    const mockRedirectionError = {
        statusCode: 302,
        response: {
            headers: {
                location: mockPaymentEndpoint
            }
        }
    };

    const mockMinimalEvent = {
        amount: 156,
        transactionReference: 'TEST_REFERENCE',
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
        expect(result).to.have.property('statusCode', 200);
        expect(result).to.have.property('body');
        const body = JSON.parse(result.body);
        expect(body).to.have.property('paymentUrl', `${mockPaymentUrl}${mockPaymentEndpoint}`);
        expect(requestStub).to.have.been.calledOnce;
    };

    it('Gets payment url from third party', async () => {
        requestStub.throws(mockRedirectionError);
        const mockEvent = Object.assign({}, mockMinimalEvent);

        const resultOfRequest = await handler.payment(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        // commonExpectations(resultOfRequest);
        resetStubs(requestStub);

        requestStub.throws(mockRedirectionError);
        mockEvent.cancelUrl = 'https://mock.cancel.url.com/';
        mockEvent.successUrl = 'https://mock.success.url.com/';
        mockEvent.errorUrl = 'https://mock.error.url.com/';

        const resultOfFullRequest = await handler.payment(mockEvent);
        logger('Result of payment url extraction:', resultOfFullRequest);

        commonExpectations(resultOfFullRequest);
    });

    it('Handles warmup event', async () => {
        requestStub.returns({ State: 'ACTIVE' }); // with args
        const mockEvent = { };

        const resultOfWarmup = await handler.payment(mockEvent);
        logger('Result of warmup call:', resultOfWarmup);

        expect(resultOfWarmup).to.exist;
        expect(resultOfWarmup).to.have.property('statusCode', 200);
        expect(resultOfWarmup).to.have.property('body', JSON.stringify({ State: 'ACTIVE' }));
    });

    it('Handles dry run', async () => {
        const mockEvent = { dryRunFakeSuccess: true };

        const resultOfDryrun = await handler.payment(mockEvent);
        logger('Result of dry run:', resultOfDryrun);

        expect(resultOfDryrun).to.exist;
        expect(resultOfDryrun).to.have.property('statusCode', 200);
        expect(resultOfDryrun).to.have.property('body');
        const body = JSON.parse(resultOfDryrun.body);
        expect(body).to.have.property('paymentUrl', config.get('ozow.endpoints.dryRun'));
    });

    it('Throws error on missing required properties', async () => {
        const mockEvent = Object.assign({}, mockMinimalEvent);
        Reflect.deleteProperty(mockEvent, 'countryCode');

        const resultOfRequest = await handler.payment(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('statusCode', 500); // ultimately should return 400
        expect(resultOfRequest).to.have.property('body', JSON.stringify('Missing required property: countryCode'));
        expect(requestStub).to.have.not.been.called;
    });

    it('Throws error on redirection failure', async () => {
        requestStub.returns('HonestlyItsTheWildWestOutHere');
        const mockEvent = Object.assign({}, mockMinimalEvent);

        const resultOfRequest = await handler.payment(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('statusCode', 500);
        expect(resultOfRequest).to.have.property('body', JSON.stringify('Payment url resulted in: HonestlyItsTheWildWestOutHere'));
        expect(requestStub).to.have.been.calledOnce;
    });

    it('Throws an err where non-Object error or missing status code', async () => {
        requestStub.throws('SomeAlamoLikeError');
        const mockEvent = Object.assign({}, mockMinimalEvent);

        const resultOfRequest = await handler.payment(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('statusCode', 500);
        expect(resultOfRequest).to.have.property('body', JSON.stringify('SomeAlamoLikeError'));
        expect(requestStub).to.have.been.calledOnce;
    });

    it('Throws an err where non-Object error or missing status code', async () => {
        requestStub.throws({ statusCode: 400, body: 'ERROR' });
        const mockEvent = Object.assign({}, mockMinimalEvent);

        const resultOfRequest = await handler.payment(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);

        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('statusCode', 500);
        expect(resultOfRequest).to.have.property('body');
        const body = JSON.parse(JSON.parse(resultOfRequest.body));
        expect(body).to.have.property('statusCode', 400);
        expect(body).to.have.property('body', 'ERROR');
        expect(requestStub).to.have.been.calledOnce;
    });

});


describe('*** UNIT TEST TRANSACTION STATUS HANDLER ***', () => {

    const mockTransactionReference = 'TEST_REFERENCE';
    const mockTransactionStatus = {
        transactionId: uuid(),
        merchantCode: 'TestMerch',
        siteCode: config.get('ozow.siteCode'),
        transactionReference: mockTransactionReference,
        currencyCode: 'ZAR',
        amount: 10,
        status: 'Abandoned',
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
        const mockEvent = { transactionReference: mockTransactionReference, isTest: true };

        const transactionStatus = await handler.status(mockEvent);
        logger('Transaction status result:', transactionStatus);

        expect(transactionStatus).to.exist;
        expect(transactionStatus).to.have.property('statusCode', 200);
        expect(transactionStatus).to.have.property('body');
        const body = JSON.parse(transactionStatus.body);
        expect(body).to.have.deep.equal([mockTransactionStatus, mockTransactionStatus, mockTransactionStatus]);
        expect(requestStub).to.have.been.called;
    });

    it('Catched thrown errors', async () => {
        requestStub.throws(new Error('RequestError'));
        const mockEvent = { transactionReference: mockTransactionReference };

        const transactionStatus = await handler.status(mockEvent);
        logger('Transaction status result on error:', transactionStatus);

        expect(transactionStatus).to.exist;
        expect(transactionStatus).to.have.property('statusCode', 500);
        expect(transactionStatus).to.have.property('body', JSON.stringify('RequestError'));
        expect(requestStub).to.have.been.calledOnce;
    });

});
