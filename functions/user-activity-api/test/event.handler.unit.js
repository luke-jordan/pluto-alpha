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
        'fetchAccountTagByPrefix': fetchAccNumberStub
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
        helper.resetStubs(lamdbaInvokeStub, getObjectStub, getQueueUrlStub, sqsSendStub, sendEmailStub, updateTagsStub, updateTxFlagsStub, fetchAccNumberStub); // no redis use here at present
    });

    const commonAssertions = ({ resultOfHandle, investmentInvocation }) => {
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({
            Bucket: config.get('templates.bucket'), Key: config.get('templates.saveEmail')
        });
        expect(sendEmailStub).to.have.been.calledOnce;
        expectNoCalls(redisGetStub, sqsSendStub);
        if (config.get('finworks.sendInvestment') === true) {
            expect(lamdbaInvokeStub).to.have.been.calledThrice; // for balance & for status & investment
            expect(lamdbaInvokeStub).to.have.been.calledWith(investmentInvocation);
            expect(fetchAccNumberStub).to.have.been.calledOnce;
            expect(updateTxFlagsStub).to.have.been.calledOnce;
        }
    };

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

        const testUserProfile = {
            systemWideUserId: testUserId,
            creationTimeEpochMillis: moment().valueOf(),
            clientId: testClientId,
            floatId: testFloatId,
            defaultCurrency: 'USD',
            defaultTimezone: 'America/New_York',
            personalName: 'Meng',
            familyName: 'Ke',
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

    it('Catches third party errors, => DLQ', async () => {
        const testUserId = uuid();
        const testClientId = uuid();
        const testFloatId = uuid();
        const testNationalId = '0340450540345';
        const testCountryCode = '';

        const mockSQSResponse = {
            ResponseMetadata: { RequestId: uuid() },
            MD5OfMessageBody: uuid(),
            MD5OfMessageAttributes: uuid(),
            MessageId: uuid()
        };

        const testUserProfile = {
            systemWideUserId: testUserId,
            creationTimeEpochMillis: moment().valueOf(),
            clientId: testClientId,
            floatId: testFloatId,
            defaultCurrency: 'USD',
            defaultTimezone: 'America/New_York',
            personalName: 'Meng',
            familyName: 'Ke',
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
        lamdbaInvokeStub.withArgs(FWAccCreationInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ statusCode: 500 })})})});
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });

        const snsEvent = wrapEventSns({ userId: testUserId, eventType: 'USER_CREATED_ACCOUNT' });

        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        logger('Result of acc creation on third party error:', resultOfHandle);

        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal({ statusCode: 500 });
        expect(lamdbaInvokeStub).to.have.been.calledWith(userProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(FWAccCreationInvocation);
        expect(updateTagsStub).to.have.not.been.called;
        expect(getQueueUrlStub).to.have.been.calledOnce;
        expect(sqsSendStub).to.have.been.calledOnce;
    });

    it('Handles saving event happy path correctly', async () => {
        const testAccountId = uuid();
        const testAccountNumber = 'POL1';
        const timeNow = moment().valueOf();
        const testUpdateTime = moment();
        const activeStubs = [lamdbaInvokeStub, getObjectStub, sqsSendStub, sendEmailStub, updateTxFlagsStub, fetchAccNumberStub];

        let investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createFinWorksInvestment'), false, {
            accountNumber: testAccountNumber,
            amount: '100',
            unit: 'WHOLE_CURRENCY',
            currency: 'USD'
        });
        
        const configureStubs = (invocation) => {
            lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
            lamdbaInvokeStub.withArgs(invocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ })})})});
            getObjectStub.returns({ promise: () => ({
                Body: { toString: () => 'This is an email template' 
            }})});
            sendEmailStub.returns({ promise: () => 'Email sent' });
            fetchAccNumberStub.resolves('POL1');
            updateTxFlagsStub.resolves({ updatedTime: testUpdateTime });
        };

        configureStubs(investmentInvocation);
        
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

        // minor variations in calls, hence the aggregation
        let snsEvent = wrapEventSns(savingEvent);
        let resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.saveCount = 1;
        configureStubs(investmentInvocation);
        sendEmailStub.throws({ promise: () => new Error('Error sending email') });
        snsEvent = wrapEventSns(savingEvent);
        resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.saveCount = 2;
        configureStubs(investmentInvocation);
        snsEvent = wrapEventSns(savingEvent);
        resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.saveCount = 3;
        savingEvent.context.savedAmount = '100::WHOLE_CURRENCY::ZAR';
        investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createFinWorksInvestment'), false, {
            accountNumber: testAccountNumber, amount: '100', unit: 'WHOLE_CURRENCY', currency: 'ZAR'
        });
        configureStubs(investmentInvocation);
        snsEvent = wrapEventSns(savingEvent);
        resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.savedAmount = '::::';
        investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createFinWorksInvestment'), false, {
            accountNumber: testAccountNumber, amount: '', unit: '', currency: ''
        });
        configureStubs(investmentInvocation);
        snsEvent = wrapEventSns(savingEvent);
        resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        logger('Result:', resultOfHandle);
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        if (config.get('finworks.sendInvestment') === true) {
            expect(lamdbaInvokeStub).to.have.been.calledThrice;
            expect(lamdbaInvokeStub).to.have.been.calledWith(investmentInvocation);
            expect(fetchAccNumberStub).to.have.been.calledOnce;
            expect(updateTxFlagsStub).to.have.been.calledOnce;
        }
        expect(getObjectStub).to.have.not.been.called;
        expect(sendEmailStub).to.have.not.been.called;
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

    it('Catches thrown errors, sends failed processes to DLQ', async () => {
        const testAccountId = uuid();
        const timeNow = moment().valueOf();

        const mockSQSResponse = {
            ResponseMetadata: { RequestId: uuid() },
            MD5OfMessageBody: uuid(),
            MD5OfMessageAttributes: uuid(),
            MessageId: uuid()
        };

        lamdbaInvokeStub.throws(new Error('Negeative contact'));
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });

        const savingEvent = {
            userId: testId,
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            timeInMillis: timeNow,
            context: {
                accountId: testAccountId,
                saveCount: 10,
                savedAmount: '100::WHOLE_CURRENCY::ZAR'
            }
        };

        const snsEvent = wrapEventSns(savingEvent);
        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);
        logger('Result of investment on error:', resultOfHandle);

        expect(resultOfHandle).to.deep.equal({ statusCode: 500 });
        expect(lamdbaInvokeStub).to.have.been.calledOnce;
        expect(getObjectStub).to.have.not.been.called;
        expect(sendEmailStub).to.have.not.been.called;
        expect(fetchAccNumberStub).to.have.not.been.called;
        expect(updateTxFlagsStub).to.have.not.been.called;
        expect(getQueueUrlStub).to.have.been.calledOnce;
        expect(sqsSendStub).to.have.been.calledOnce;
    });

});
