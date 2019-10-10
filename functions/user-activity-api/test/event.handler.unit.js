'use strict';

const logger = require('debug')('jupiter:event-handler:test');
const config = require('config');
const uuid = require('uuid');
const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
chai.use(require('sinon-chai'));
const proxyquire = require('proxyquire');

const helper = require('./test.helper');

const lamdbaInvokeStub = sinon.stub();
const sendEmailStub = sinon.stub();
const getObjectStub = sinon.stub();
const sqsSendStub = sinon.stub();

const redisGetStub = sinon.stub();

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

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub; 
    }
}

class MockSQSClient {
    constructor () { 
        this.sendMessage = sqsSendStub; 
    }
}

class MockRedis {
    constructor () { 
        this.get = redisGetStub; 
    }
}

const eventHandler = proxyquire('../event-handler', {
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'SES': MockSesClient,
        'SQS': MockSQSClient,
        'S3': MockS3Client
    },
    'ioredis': MockRedis
});

const wrapEventSns = (event) => ({
    Records: [{ Sns: { Message: JSON.stringify(event) }}]
});

const expectNoCalls = (...stubs) => {
    stubs.forEach((stub) => expect(stub).to.not.have.been.called);  
};

describe('*** UNIT TESTING EVENT HANDLING HAPPY PATHS ***', () => {

    const testId = uuid();

    beforeEach(() => {
        helper.resetStubs(lamdbaInvokeStub, getObjectStub, sqsSendStub, sendEmailStub); // no redis use here at present
    });

    it('Handles non-special (e.g., login) event properly', async () => {
        const snsEvent = wrapEventSns({ userId: testId, eventType: 'USER_LOGIN' });
        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        logger('Result: ', resultOfHandle);
        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expectNoCalls(lamdbaInvokeStub, getObjectStub, sqsSendStub, sendEmailStub, redisGetStub);
    });

    it('Handles account opening properly', async () => {
        const snsEvent = wrapEventSns({ userId: testId, eventType: 'PASSWORD_SET' });
        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 }); // for now
        expectNoCalls(lamdbaInvokeStub, getObjectStub, sqsSendStub, sendEmailStub, redisGetStub);
    });

    it('Handles saving event happy path correctly', async () => {
        const testAccountId = uuid();
        const timeNow = moment().valueOf();

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
        
        getObjectStub.returns({ promise: () => ({ 
            Body: { toString: () => 'This is an email template' }
        })});
        sendEmailStub.returns({ promise: () => 'Email sent' });
        
        const savingEvent = {
            userId: testId,
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            timeInMillis: timeNow,
            context: {
                accountId: testAccountId,
                saveCount: 10,
                savedAmount: '100::WHOLE_CURRENCY::USD'
            }
        };

        const snsEvent = wrapEventSns(savingEvent);
        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(lamdbaInvokeStub).to.have.been.calledTwice; // for balance & for status
        expect(getObjectStub).to.have.been.
            calledOnceWithExactly({ Bucket: config.get('templates.bucket'), Key: config.get('templates.saveEmail') });
        expect(sendEmailStub).to.have.been.calledOnce;
        expectNoCalls(redisGetStub, sqsSendStub);
    });

    it('Handles withdrawal event happy path correctly', async () => {
        const timeNow = moment().valueOf();

        redisGetStub.resolves(JSON.stringify({ account: 'Hello' }));
        
        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
        getObjectStub.returns({ promise: () => ({ 
            Body: { toString: () => 'This is an email template' }
        })});
        sendEmailStub.returns({ promise: () => 'Email sent' });
        
        const withdrawalEvent = {
            userId: testId,
            eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            timeInMillis: timeNow,
            context: {
                withdrawalAmount: '100::WHOLE_CURRENCY::USD'
            }
        };

        const snsEvent = wrapEventSns(withdrawalEvent);
        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);

        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(redisGetStub).to.have.been.calledOnceWithExactly(`${testId}::BANK_DETAILS`);
        // expect(lamdbaInvokeStub).to.have.been.calledOnce;
        expect(getObjectStub).to.have.been.
            calledOnceWithExactly({ Bucket: config.get('templates.bucket'), Key: config.get('templates.withdrawalEmail') });
        expect(sendEmailStub).to.have.been.calledOnce;
        expectNoCalls(sqsSendStub);
    });

});
