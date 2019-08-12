'use strict';

const logger = require('debug')('jupiter:logging-module:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');
const stringify = require('json-stable-stringify');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const momentStub = sinon.stub();
const snsPublishStub = sinon.stub();
class MockSNS {
    constructor () {
        this.publish = snsPublishStub;
    }
}

const eventPublisher = proxyquire('../index', {
    'moment': momentStub,
    'aws-sdk': { 
        'SNS': MockSNS
    }
});

const resetStubs = () => {
    momentStub.reset();
    snsPublishStub.reset();
};

describe('*** UNIT TEST PUBLISHING MODULE ***', () => {

    const testTime = moment();
    const testUserId = uuid();

    const wellFormedEvent = (userId, eventType, options = {}) => ({
        userId,
        eventType,
        timestamp: testTime.valueOf(),
        interface: options.interface,
        initiator: options.initiator,
        context: options.initiator
    });

    const wellFormedSnsPublish = (userId, eventType, options) => ({
        Message: stringify(wellFormedEvent(userId, eventType, options)),
        Subject: eventType,
        TopicArn: config.get('publishing.userEvents.topicArn')
    });

    const dummySnsResult = {
        ResponseMetadata: { RequestId: uuid() },
        MessageId: uuid()
    };

    beforeEach(() => resetStubs());

    it('Happy path, wraps a basic call and publishes it to SNS', async () => {
        const happyPublish = wellFormedSnsPublish(testUserId, 'ADD_CASH_INITITIATED');
        logger('Initiating happy path test for logging, expecting: ', happyPublish);

        momentStub.withArgs().returns(testTime);
        snsPublishStub.withArgs(sinon.match(happyPublish)).returns({ promise: () => dummySnsResult });

        const publishResult = await eventPublisher.publishUserEvent(testUserId, 'ADD_CASH_INITITIATED');
        logger('Result of publish: ', publishResult);

        expect(publishResult).to.exist;
        expect(publishResult).to.deep.equal({ result: 'SUCCESS' });
        expect(snsPublishStub).to.have.been.calledOnceWithExactly(happyPublish);
    });

    it('Swallows and returns failure, if publish fails or error thrown', async () => {
        const badPublish = wellFormedSnsPublish('bad-user-id', 'BAD_EVENT');
        momentStub.withArgs().returns(testTime);
        snsPublishStub.withArgs(badPublish).returns({ promise: () => 'No message ID here' });

        const result1 = await eventPublisher.publishUserEvent('bad-user-id', 'BAD_EVENT');
        expect(result1).to.exist;
        expect(result1).to.deep.equal({ result: 'FAILURE' });

        const worsePublish = wellFormedSnsPublish('worse-user-id', 'VERYBAD');
        snsPublishStub.withArgs(worsePublish).throws(new Error('That was terrible'));

        const result2 = await eventPublisher.publishUserEvent('worse-user-id', 'VERYBAD');
        expect(result2).to.exist;
        expect(result2).to.deep.equal({ result: 'FAILURE' });
    });

});
