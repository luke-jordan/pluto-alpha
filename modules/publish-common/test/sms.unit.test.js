'use strict';

// const logger = require('debug')('jupiter:sms:unit');
const config = require('config');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const lambdaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
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
        lambdaInvokeStub.reset();
    });

    it('Sends sms message, sync', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendOutboundMessages'), false, mockLambdaPayload);
        lambdaInvokeStub.returns({ promise: () => mockLambdaResponse({ result: 'SUCCESS' })});

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage, sendSync: true });
  
        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Sends sms message, async', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendOutboundMessages'), true, mockLambdaPayload);
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 202, Payload: ''}) });

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });
  
        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Fails on bad Lambda response', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendOutboundMessages'), true, mockLambdaPayload);
        lambdaInvokeStub.returns({ promise: () => mockLambdaResponse({ result: 'ERROR' }, 500)});

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Catches thrown error', async () => {
        const mockLambdaPayload = { message: testMessage, phoneNumber: testPhoneNumber };
        const expectedInvocation = wrapLambdaInvoc(config.get('lambdas.sendOutboundMessages'), true, mockLambdaPayload);
        lambdaInvokeStub.throws(new Error('Connection error'));

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

});
