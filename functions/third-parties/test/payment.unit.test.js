'use strict';

const logger = require('debug')('jupiter:third-parties:payment-unit-test');
const uuid = require('uuid/v4');
const config = require('config');

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
    const redirectionError = {
        statusCode: 302,
        response: {
            headers: {
                location: mockPaymentEndpoint
            }
        }
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
        requestStub.throws(redirectionError);
        const mockEvent = {
            amount: 156,
            transactionReference: 'TEST_REFERENCE',
            bankReference: 'TEST_REFERENCE',
            isTest: false,
            siteCode: config.get('ozow.siteCode'),
            countryCode: 'ZA',
            currencyCode: 'ZAR'
        };

        const resultOfRequest = await handler.getPaymentUrl(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);
        commonExpectations(resultOfRequest);
        resetStubs(requestStub);

        requestStub.throws(redirectionError);
        mockEvent.cancelUrl = 'https://mock.cancel.url.com/';
        mockEvent.successUrl = 'https://mock.success.url.com/';
        mockEvent.errorUrl = 'https://mock.error.url.com/';

        const resultOfFullRequest = await handler.getPaymentUrl(mockEvent);
        logger('Result of payment url extraction:', resultOfFullRequest);
        commonExpectations(resultOfFullRequest);
    });

    it('Handles warmup event', async () => {
        requestStub.returns({ State: 'ACTIVE' }); // with args
        const mockEvent = { };

        const resultOfWarmup = await handler.getPaymentUrl(mockEvent);
        logger('Result of warmup call:', resultOfWarmup);
        expect(resultOfWarmup).to.exist;
        expect(resultOfWarmup).to.have.property('statusCode', 200);
        expect(resultOfWarmup).to.have.property('body', JSON.stringify({ State: 'ACTIVE' }));
    });

    it('Handles dry run', async () => {
        const mockEvent = { dryRunFakeSuccess: true };

        const resultOfDryrun = await handler.getPaymentUrl(mockEvent);
        logger('Result of dry run:', resultOfDryrun);
        expect(resultOfDryrun).to.exist;
        expect(resultOfDryrun).to.have.property('statusCode', 200);
        expect(resultOfDryrun).to.have.property('body');
        const body = JSON.parse(resultOfDryrun.body);
        expect(body).to.have.property('paymentUrl', config.get('ozow.endpoints.dryRun'));
    });

    it('Throws error on missing required properties', async () => {
        const mockEvent = {
            transactionReference: 'TEST_REFERENCE',
            bankReference: 'TEST_REFERENCE',
            isTest: true,
            siteCode: config.get('ozow.siteCode'),
            countryCode: 'ZA',
            currencyCode: 'ZAR',
            amount: 10
        };
        Reflect.deleteProperty(mockEvent, 'countryCode');

        const resultOfRequest = await handler.getPaymentUrl(mockEvent);
        logger('Result of payment url extraction:', resultOfRequest);
        expect(resultOfRequest).to.exist;
        expect(resultOfRequest).to.have.property('statusCode', 500); // ultimately should return 400
        expect(resultOfRequest).to.have.property('body', JSON.stringify('Missing required property: countryCode'));
        expect(requestStub).to.have.not.been.called;
    });

});
