'use strict';

const logger = require('debug')('jupiter:logging-module:test');

const crypto = require('crypto');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const stringify = require('json-stable-stringify');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const uuidStub = sinon.stub();
const momentStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const getObjectStub = sinon.stub();
const sendEmailStub = sinon.stub();
const snsPublishStub = sinon.stub();
class MockSNS {
    constructor () {
        this.publish = snsPublishStub;
    }
}

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
    }
}

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

class MockSesClient {
    constructor () { 
        this.sendEmail = sendEmailStub; 
    }
}

const eventPublisher = proxyquire('../index', {
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'SNS': MockSNS,
        'SES': MockSesClient,
        'S3': MockS3Client
    },
    'uuid/v4': uuidStub
});

const resetStubs = () => {
    uuidStub.reset();
    momentStub.reset();
    snsPublishStub.reset();
    getObjectStub.reset();
    sendEmailStub.reset();
    lamdbaInvokeStub.reset();
};

describe('*** UNIT TEST PUBLISHING MODULE ***', () => {

    const testTime = moment();
    const testUserId = uuid();

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    const expectedHash = (eventType) => crypto.createHmac(config.get('crypto.algo'), config.get('crypto.secret')).
        update(`${config.get('crypto.secret')}_${eventType}`).
        digest(config.get('crypto.digest'));

    const wellFormedEvent = (userId, eventType, options = {}) => ({
        userId,
        eventType,
        timestamp: testTime.valueOf(),
        interface: options.interface,
        initiator: options.initiator,
        context: options.initiator,
        hash: expectedHash(eventType)
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
        snsPublishStub.returns({ promise: () => dummySnsResult });

        const publishResult = await eventPublisher.publishUserEvent(testUserId, 'ADD_CASH_INITITIATED');

        expect(publishResult).to.exist;
        expect(publishResult).to.deep.equal({ result: 'SUCCESS' });
        expect(snsPublishStub).to.have.been.calledOnceWithExactly(happyPublish);
    });

    it('Sends system email, sync lambda call', async () => {
        const testMessageId = uuid();
        const targetEmails = ['user1@email.com', 'user2@email.com'];

        const templateBucket = config.has('templates.bucket') ? config.get('templates.bucket') : 'staging.jupiter.templates';
        const templateKey = 'test_template';

        const testTemplate = '<p>Greetings {}, from Jupiter.</p>';
        getObjectStub.withArgs({ Bucket: templateBucket, Key: templateKey }).returns({ promise: () => ({ Body: { toString: () => testTemplate }})});
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ result: 'SUCCESS' })});
        uuidStub.returns(testMessageId);

        const expectedInvocation = {
            FunctionName: 'outbound_comms_send',
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                emailMessages: targetEmails.map((emailAddress) => ({
                    from: 'system@jupitersave.com',
                    html: '<p>Greetings Jacob, from Jupiter.</p>',
                    messageId: testMessageId,
                    subject: 'Salutations',
                    text: 'Greetings Jacob, from Jupiter.',
                    to: emailAddress
                })
            )})
        };

        const emailDetails = {
            originAddress: 'system@jupitersave.com',
            subject: 'Salutations',
            toList: targetEmails,
            bodyTemplateKey: templateKey,
            templateVariables: 'Jacob',
            sendSync: true
        };

        const resultOfDispatch = await eventPublisher.sendSystemEmail(emailDetails);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: templateBucket, Key: templateKey });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Sends system email, async lambda call', async () => {
        const testMessageId = uuid();
        const targetEmails = ['user1@email.com', 'user2@email.com'];

        const templateBucket = config.has('templates.bucket') ? config.get('templates.bucket') : 'staging.jupiter.templates';
        const templateKey = 'test_template';

        const testTemplate = '<p>Greetings {}, from Jupiter.</p>';
        getObjectStub.withArgs({ Bucket: templateBucket, Key: templateKey }).returns({ promise: () => ({ Body: { toString: () => testTemplate }})});
        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202, Payload: ''}) });
        uuidStub.returns(testMessageId);

        const expectedInvocation = {
            FunctionName: 'outbound_comms_send',
            InvocationType: 'Event',
            Payload: JSON.stringify({
                emailMessages: targetEmails.map((emailAddress) => ({
                    from: 'system@jupitersave.com',
                    html: '<p>Greetings Jacob, from Jupiter.</p>',
                    messageId: testMessageId,
                    subject: 'Salutations',
                    text: 'Greetings Jacob, from Jupiter.',
                    to: emailAddress
                })
            )})
        };

        const emailDetails = {
            originAddress: 'system@jupitersave.com',
            subject: 'Salutations',
            toList: targetEmails,
            bodyTemplateKey: templateKey,
            templateVariables: 'Jacob'
        };

        const resultOfDispatch = await eventPublisher.sendSystemEmail(emailDetails);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: templateBucket, Key: templateKey });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('System email dispatch uses default source address where none is provided', async () => {
        const testMessageId = uuid();
        const targetEmails = ['user1@email.com', 'user2@email.com'];

        const templateBucket = config.has('templates.bucket') ? config.get('templates.bucket') : 'staging.jupiter.templates';
        const templateKey = 'test_template';

        const testTemplate = '<p>Greetings {}, from Jupiter.</p>';
        getObjectStub.withArgs({ Bucket: templateBucket, Key: templateKey }).returns({ promise: () => ({ Body: { toString: () => testTemplate }})});
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ result: 'SUCCESS' })});
        uuidStub.returns(testMessageId);

        const expectedInvocation = {
            FunctionName: 'outbound_comms_send',
            InvocationType: 'Event',
            Payload: JSON.stringify({
                emailMessages: targetEmails.map((emailAddress) => ({
                    from: config.get('publishing.eventsEmailAddress'),
                    html: '<p>Greetings Jacob, from Jupiter.</p>',
                    messageId: testMessageId,
                    subject: 'Salutations',
                    text: 'Greetings Jacob, from Jupiter.',
                    to: emailAddress
                })
            )})
        };

        const emailDetails = {
            subject: 'Salutations',
            toList: targetEmails,
            bodyTemplateKey: templateKey,
            templateVariables: 'Jacob'
        };

        const resultOfDispatch = await eventPublisher.sendSystemEmail(emailDetails);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: templateBucket, Key: templateKey });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
    });

    it('Handles the publication of multiple user events at once', async () => {
        const userIds = [testUserId, testUserId, testUserId];

        momentStub.withArgs().returns(testTime);
        snsPublishStub.returns({ promise: () => dummySnsResult });

        const resultOfDispatch = await eventPublisher.publishMultiUserEvent(userIds, 'USER_LOGIN');

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ successCount: 3, failureCount: 0 });
        expect(snsPublishStub).to.have.been.calledThrice;

        const expectedSnsArgs = {
            Message: JSON.stringify({
                eventType: 'USER_LOGIN',
                hash: '0c3c5d2646a4ef310524f8458b7f42f0c8e5b15301a8c8a41488649626340c29',
                timestamp: testTime.valueOf(),
                userId: testUserId
            }),
            Subject: 'USER_LOGIN',
            TopicArn: config.get('publishing.userEvents.topicArn')
        };
        expect(snsPublishStub).to.have.been.calledWith(expectedSnsArgs);
    });

    it('Catches thrown errors during bulk publish', async () => {
        const userIds = { throws: 'error' };

        momentStub.withArgs().returns(testTime);
        snsPublishStub.throws(new Error('Publish error'));

        const resultOfDispatch = await eventPublisher.publishMultiUserEvent(userIds, 'USER_LOGIN');

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'FAILURE' });
        expect(snsPublishStub).to.have.not.been.called;
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
