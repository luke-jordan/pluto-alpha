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
        'SQS': MockSQSClient
    },
    '@noCallThru': true
});

describe('*** UNIT TEST SQS EVENT QUEUEING ***', () => {

    it('Queues events properly', async () => {
        const expectedSQSParams = {
            MessageAttributes: {
                MessageBodyDataType: { DataType: 'String', StringValue: 'JSON' }
            },
            MessageBody: JSON.stringify({ some: 'value' }),
            QueueUrl: 'test/queue/url'
        };

        const mockSQSResponse = {
            ResponseMetadata: { RequestId: uuid() },
            MD5OfMessageBody: uuid(),
            MD5OfMessageAttributes: uuid(),
            MessageId: uuid()
        };

        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });
        
        const testEvent = {
            queueName: 'test-queue-name',
            payload: { some: 'value' }
        };

        const resultOfQueue = await handler.queueEvents([testEvent]);

        expect(resultOfQueue).to.exist;
        expect(resultOfQueue).to.deep.equal({ successCount: 1, failureCount: 0 });
        expect(getQueueUrlStub).to.have.been.calledOnceWithExactly({ QueueName: 'test-queue-name' });
        expect(sqsSendStub).to.have.been.calledOnceWithExactly(expectedSQSParams);
    });
});
