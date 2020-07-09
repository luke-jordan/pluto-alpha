'use strict';

// const logger = require('debug')('jupiter:event-handler:test');
const config = require('config');
const uuid = require('uuid');
const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
chai.use(require('sinon-chai'));
const proxyquire = require('proxyquire').noCallThru();

const helper = require('./test.helper');

const lamdbaInvokeStub = sinon.stub();
const snsPublishStub = sinon.stub();
const safeEmailStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();

class MockLambdaClient {
    constructor () { 
        this.invoke = lamdbaInvokeStub; 
    }
}

class MockSnsClient {
    constructor () { 
        this.publish = snsPublishStub; 
    }
}

class MockRedis {
    constructor () { 
        this.get = redisGetStub;
        this.set = redisSetStub;
    }
}

const eventHandler = proxyquire('../event-handler', {
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'SNS': MockSnsClient,
        // eslint-disable-next-line no-empty-function
        'config': { update: () => ({}) }
    },
    'ioredis': MockRedis,
    './persistence/rds': {
        'fetchTransaction': fetchTransactionStub,
        '@noCallThru': true
    },
    'publish-common': {
        'safeEmailSendPlain': safeEmailStub,
        '@noCallThru': true
    }
});

const wrapEventSqs = (event) => ({
    Records: [{ body: JSON.stringify({ Message: JSON.stringify(event) }) }]
});

const resetStubs = () => helper.resetStubs(lamdbaInvokeStub, fetchTransactionStub, redisGetStub, redisSetStub, safeEmailStub);

describe('*** UNIT TEST WITHDRAWAL CANCELLED ***', () => {
    const testTimestamp = moment().format();

    const testTxId = uuid();
    const mockUserId = uuid();

    beforeEach(resetStubs);

    it('Handles withdrawal event happy path correctly', async () => {
        const safeEmailParams = {
            from: 'noreply@jupitersave.com',
            to: ['luke@jupitersave.com'],
            subject: 'Jupiter withdrawal cancelled',
            html: '<p>Hello,</p><p>Good news! Jane Doe has decided to cancel their withdrawal. ' +
                'This was sent with bank reference, JDOE1010. Please abort the withdrawal!</p><p>The Jupiter System</p>',
            text: 'Jane Doe cancelled their withdrawal'
        };

        const profileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: mockUserId, includeContactMethod: false });
        const testProfile = { personalName: 'Jane', familyName: 'Doe', emailAddress: 'someonelse@jupitersave.com' };
        const testProfilePayload = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testProfile)}) };
        lamdbaInvokeStub.returns({ promise: () => (testProfilePayload) });

        fetchTransactionStub.resolves({ settlementStatus: 'CANCELLED', humanReference: 'JDOE1010' });
        safeEmailStub.resolves({ result: 'SUCCESS' });
        
        const withdrawalEvent = {
            userId: mockUserId,
            eventType: 'WITHDRAWAL_EVENT_CANCELLED',
            timestamp: testTimestamp,
            context: {
                transactionId: testTxId,
                oldStatus: 'PENDING',
                newStatus: 'CANCELLED'
            }
        };

        const sqsBatch = wrapEventSqs(withdrawalEvent);
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsBatch);

        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal([{ statusCode: 200 }]);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(profileInvocation);
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(testTxId);
        expect(safeEmailStub).to.have.been.calledOnceWithExactly(safeEmailParams);
    });

});
