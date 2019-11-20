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
const getQueueUrlStub = sinon.stub();

const updateTagsStub = sinon.stub();
const updateTxFlagsStub = sinon.stub();
const fetchAccNumberStub = sinon.stub();

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
        this.getQueueUrl = getQueueUrlStub;
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
    'ioredis': MockRedis,
    './persistence/rds': {
        'updateAccountTags': updateTagsStub,
        'updateTxFlags': updateTxFlagsStub,
        'fetchFinWorksAccountNo': fetchAccNumberStub
    }
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
        helper.resetStubs(lamdbaInvokeStub, getObjectStub, sqsSendStub, sendEmailStub, updateTagsStub, updateTxFlagsStub, fetchAccNumberStub); // no redis use here at present
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

    it('Registers account with third party, persists account id from third party', async () => {
        const testUserId = uuid();
        const testClientId = uuid();
        const testFloatId = uuid();
        const testUpdateTime = moment();
        const testNationalId = '0340450540345';
        const testCountryCode = '';

        const mockSQSResponse = {
            ResponseMetadata: {
                RequestId: '056077cb-1e2c-5796-b014-2270726c8167'
            },
            MD5OfMessageBody: '646ae581a4a5b03ccd0aabe3318fb59f',
            MD5OfMessageAttributes: '81cb5a1c923156cc0dcb57ddf7a30fcd',
            MessageId: '1a57df66-4d6a-4971-afeb-78e5f77d05d7'
        };

        const testUserProfile = {
            systemWideUserId: testUserId,
            creationTimeEpochMillis: moment().valueOf(),
            clientId: testClientId,
            floatId: testFloatId,
            defaultCurrency: 'USD',
            defaultTimezone: 'China',
            personalName: 'Mencius',
            familyName: 'unknown',
            phoneNumber: '16061110000',
            emailAddress: 'mencius@confucianism.com',
            countryCode: testCountryCode,
            nationalId: testNationalId,
            userStatus: 'CREATED',
            kycStatus: 'CONTACT_VERIFIED',
            securedStatus: 'PASSWORD_SET',
            updatedTimeEpochMillis: moment().valueOf()
        };

        const userProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId });
        const FWAccCreationInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createFinWorksAccount'), false, {
            idNumber: testUserProfile.nationalId,
            surname: testUserProfile.familyName,
            firstNames: testUserProfile.personalName
        });

        lamdbaInvokeStub.withArgs(userProfileInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testUserProfile)})})});
        lamdbaInvokeStub.withArgs(FWAccCreationInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ accountNumber: 'POL1' })})})});
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });
        updateTagsStub.resolves({ updatedTime: testUpdateTime });

        const snsEvent = wrapEventSns({ userId: testUserId, eventType: 'USER_CREATED_ACCOUNT' });

        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);

        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(lamdbaInvokeStub).to.have.been.calledWith(userProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(FWAccCreationInvocation);
        expect(updateTagsStub).to.have.been.calledOnceWithExactly(testUserId, 'FINWORKS::POL1');
        expect(getQueueUrlStub).to.have.not.been.called;
        expect(sqsSendStub).to.have.not.been.called;
    });

    it('Handles saving event happy path correctly', async () => {
        const testAccountId = uuid();
        const testAccountNumber = 'POL1';
        const timeNow = moment().valueOf();
        const testUpdateTime = moment();

        const investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createFinWorksInvestment'), false, {
            accountNumber: testAccountNumber,
            amount: '100',
            unit: 'WHOLE_CURRENCY',
            currency: 'USD'
        });

        logger('expecting:', investmentInvocation);

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
        lamdbaInvokeStub.withArgs(investmentInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ })})})});
        getObjectStub.returns({ promise: () => ({ 
            Body: { toString: () => 'This is an email template' }
        })});
        sendEmailStub.returns({ promise: () => 'Email sent' });
        fetchAccNumberStub.resolves('POL1');
        updateTxFlagsStub.resolves({ updatedTime: testUpdateTime });

        
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
        
        // todo: add arg expectaions
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(lamdbaInvokeStub).to.have.been.calledThrice; // for balance & for status & investment
        expect(lamdbaInvokeStub).to.have.been.calledWith(investmentInvocation);
        expect(getObjectStub).to.have.been.
            calledOnceWithExactly({ Bucket: config.get('templates.bucket'), Key: config.get('templates.saveEmail') });
        expect(sendEmailStub).to.have.been.calledOnce;
        expect(fetchAccNumberStub).to.have.been.calledOnce;
        expect(updateTxFlagsStub).to.have.been.calledOnce;
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

    // todo: test error handling and DLQ dispatch

});
