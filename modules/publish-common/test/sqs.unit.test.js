'use strict';

// const logger = require('debug')('jupiter:event-handler:test');
const uuid = require('uuid');

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
chai.use(require('sinon-chai'));
const proxyquire = require('proxyquire').noCallThru();

const sqsSendStub = sinon.stub();
const getQueueUrlStub = sinon.stub();
const lambdaInvokeStub = sinon.stub();
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
        this.invoke = lambdaInvokeStub;
    }
}

class MockSesClient {
    constructor () { 
        this.sendEmail = sendEmailStub; 
    }
}

class MockSQSClient {
    constructor () { 
        this.sendMessage = sqsSendStub; 
        this.getQueueUrl = getQueueUrlStub;
    }
}

const handler = proxyquire('../index', {
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'SNS': MockSNS,
        'SES': MockSesClient,
        'S3': MockS3Client,
        'SQS': MockSQSClient,
        // eslint-disable-next-line no-empty-function
        'config': { update: () => ({}) }
    },
    '@noCallThru': true
});

describe('*** UNIT TEST SQS EVENT QUEUEING ***', () => {

    const mockSQSRequest = (payload) => ({
        MessageAttributes: {
            MessageBodyDataType: { DataType: 'String', StringValue: 'JSON' }
        },
        MessageBody: JSON.stringify(payload),
        QueueUrl: 'test/queue/url'
    });

    const mockSQSResponse = {
        ResponseMetadata: { RequestId: uuid() },
        MD5OfMessageBody: uuid(),
        MD5OfMessageAttributes: uuid(),
        MessageId: uuid()
    };

    beforeEach(() => [sqsSendStub, getQueueUrlStub].map((stub) => stub.reset()));

    it('Queues events properly', async () => {
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });
        
        const queueName = 'test-queue-name';
        const payload = { some: 'value' };

        const resultOfQueue = await handler.sendToQueue(queueName, [payload]);

        expect(resultOfQueue).to.exist;
        expect(resultOfQueue).to.deep.equal({ successCount: 1, failureCount: 0 });
        expect(getQueueUrlStub).to.have.been.calledOnceWithExactly({ QueueName: 'test-queue-name' });
        expect(sqsSendStub).to.have.been.calledOnceWithExactly(mockSQSRequest(payload));
    });

    it('Sends event to dead letter queue', async () => {
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });

        const queueName = 'test-queue-name';
        const mockEvent = { some: 'value' };

        const resultOfQueue = await handler.sendToDlq(queueName, mockEvent);

        expect(resultOfQueue).to.exist;
        expect(resultOfQueue).to.deep.equal({ result: 'SUCCESS' });
        expect(getQueueUrlStub).to.have.been.calledOnceWithExactly({ QueueName: 'test-queue-name' });
        expect(sqsSendStub).to.have.been.calledOnceWithExactly(mockSQSRequest({ event: mockEvent }));
    });
});
