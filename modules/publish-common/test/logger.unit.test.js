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

const momentStub = sinon.stub();
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

class MockSesClient {
    constructor () { 
        this.sendEmail = sendEmailStub; 
    }
}

const eventPublisher = proxyquire('../index', {
    'moment': momentStub,
    'aws-sdk': { 
        'SNS': MockSNS,
        'SES': MockSesClient,
        'S3': MockS3Client
    }
});

const resetStubs = () => {
    momentStub.reset();
    snsPublishStub.reset();
    getObjectStub.reset();
    sendEmailStub.reset();
};

describe('*** UNIT TEST PUBLISHING MODULE ***', () => {

    const testTime = moment();
    const testUserId = uuid();

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
        logger('Result of publish: ', publishResult);

        expect(publishResult).to.exist;
        expect(publishResult).to.deep.equal({ result: 'SUCCESS' });
        expect(snsPublishStub).to.have.been.calledOnceWithExactly(happyPublish);
    });

    it('Sends system email', async () => {
        const templateBucket = config.has('templates.bucket') ? config.get('templates.bucket') : 'staging.jupiter.templates';
        const templateKey = 'test_template';

        const testTemplate = '<p>Greetings {}, from Jupiter.</p>';
        getObjectStub.withArgs({ Bucket: templateBucket, Key: templateKey }).returns({ promise: () => ({ Body: { toString: () => testTemplate }})});
        sendEmailStub.returns({ promise: () => 'Email sent' });

        const expectedEmail = {
            Destination: {
                ToAddresses: ['user1@email.com', 'user2@email.com']
            },
            Message: {
                Body: {
                    Html: { Data: '<p>Greetings Jacob, from Jupiter.</p>' },
                    Text: { Data: 'Jupiter system email.' }
                },
                Subject: { Data: 'Salutations' }
            },
            Source: 'system@jupitersave.com',
            ReplyToAddresses: ['system@jupitersave.com'],
            ReturnPath: 'system@jupitersave.com'
        };

        const emailDetails = {
            originAddress: 'system@jupitersave.com',
            subject: 'Salutations',
            toList: ['user1@email.com', 'user2@email.com'],
            bodyTemplateKey: templateKey,
            templateVariables: 'Jacob'
        };

        const resultOfDispatch = await eventPublisher.sendSystemEmail(emailDetails);
        logger('Result of system email dispatch:', resultOfDispatch);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: templateBucket, Key: templateKey });
        expect(sendEmailStub).to.have.been.calledOnceWithExactly(expectedEmail);
    });

    it('System email dispatch uses default source address where none is provided', async () => {
        const templateBucket = config.has('templates.bucket') ? config.get('templates.bucket') : 'staging.jupiter.templates';
        const templateKey = 'test_template';

        const testTemplate = '<p>Greetings {}, from Jupiter.</p>';
        getObjectStub.withArgs({ Bucket: templateBucket, Key: templateKey }).returns({ promise: () => ({ Body: { toString: () => testTemplate }})});
        sendEmailStub.returns({ promise: () => 'Email sent' });

        const expectedEmail = {
            Destination: {
                ToAddresses: ['user1@email.com', 'user2@email.com']
            },
            Message: {
                Body: {
                    Html: { Data: '<p>Greetings Jacob, from Jupiter.</p>' },
                    Text: { Data: 'Jupiter system email.' }
                },
                Subject: { Data: 'Salutations' }
            },
            Source: 'insert_default_email',
            ReplyToAddresses: ['insert_default_email'],
            ReturnPath: 'insert_default_email'
        };

        const emailDetails = {
            subject: 'Salutations',
            toList: ['user1@email.com', 'user2@email.com'],
            bodyTemplateKey: templateKey,
            templateVariables: 'Jacob'
        };

        const resultOfDispatch = await eventPublisher.sendSystemEmail(emailDetails);
        logger('Result of system email dispatch:', resultOfDispatch);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: templateBucket, Key: templateKey });
        expect(sendEmailStub).to.have.been.calledOnceWithExactly(expectedEmail);
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
