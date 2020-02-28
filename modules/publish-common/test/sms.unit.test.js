'use strict';

const logger = require('debug')('jupiter:sms:unit');
const uuid = require('uuid/v4');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const snsPublishStub = sinon.stub();
class MockSNS {
    constructor () {
        this.publish = snsPublishStub;
    }
}

const eventPublisher = proxyquire('../index', {
    'aws-sdk': { 'SNS': MockSNS }
});

describe('*** UNIT TEST GENERIC SMS FUNCTION ***', () => {

    const testPhoneNumber = '+278923344351';
    const testMessage = 'Greetings user. Welcome to Jupiter.';

    const expectSnsArgs = {
        Message: testMessage,
        MessageStructure: 'string',
        PhoneNumber: testPhoneNumber
    };

    beforeEach(() => {
        snsPublishStub.reset();
    });

    it('Sends sms message', async () => {
    
        const testSnsResponse = {
            ResponseMetadata: { RequestId: uuid() },
            MessageId: uuid()
        };

        snsPublishStub.returns({ promise: () => testSnsResponse });

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });
        logger('Result of sms dispatch:', resultOfDispatch);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });

        expect(snsPublishStub).to.have.been.calledOnceWithExactly(expectSnsArgs);
    });

    it('Fails on bad SNS response', async () => {
        const testSnsResponse = {
            ResponseMetadata: { RequestId: uuid() }
        };

        snsPublishStub.returns({ promise: () => testSnsResponse });

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });
        logger('Result of sms dispatch:', resultOfDispatch);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });

        expect(snsPublishStub).to.have.been.calledOnceWithExactly(expectSnsArgs);
    });

    it('Catches thrown error', async () => {
        snsPublishStub.throws(new Error('Connection error'));

        const resultOfDispatch = await eventPublisher.sendSms({ phoneNumber: testPhoneNumber, message: testMessage });
        logger('Result of sms dispatch:', resultOfDispatch);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });

        expect(snsPublishStub).to.have.been.calledOnceWithExactly(expectSnsArgs);
    });

});
