'use strict';

// const logger = require('debug')('jupiter:sms:unit');
const config = require('config');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const eventPublisher = proxyquire('../index', {
    'aws-sdk': { 'Lambda': MockLambdaClient }
});

describe('*** UNIT TEST GENERIC SMS FUNCTION ***', () => {

    const testPhoneNumber = '+278923344351';
    const testMessage = 'Greetings user. Welcome to Jupiter.';

    const wrapLambdaInvoc = (functionName, async, payload) => ({
        FunctionName: functionName,
        InvocationType: async ? 'Event' : 'RequestResponse',
        Payload: JSON.stringify(payload)
    });

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    beforeEach(() => {
        lamdbaInvokeStub.reset();
    });

    it('Sends sms message', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendSmsMessages'), true, mockLambdaPayload);
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ result: 'SUCCESS' })});

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });
  
        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Fails on bad Lambda response', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendSmsMessages'), true, mockLambdaPayload);
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ result: 'ERROR' }, 500)});

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Catches thrown error', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendSmsMessages'), true, mockLambdaPayload);
        lamdbaInvokeStub.throws(new Error('Connection error'));

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

});
