'use strict';

const logger = require('debug')('jupiter:event-handler:test');
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
const getObjectStub = sinon.stub();
const sqsSendStub = sinon.stub();
const snsPublishStub = sinon.stub();
const getQueueUrlStub = sinon.stub();

const sendEmailStub = sinon.stub();
const sendSmsStub = sinon.stub();

const getHumanRefStub = sinon.stub();
const updateTagsStub = sinon.stub();
const updateTxFlagsStub = sinon.stub();
const fetchBSheetAccStub = sinon.stub();
const getFriendListStub = sinon.stub();

const publishUserEventStub = sinon.stub();

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
        this.set = redisSetStub;
    }
}

const eventHandler = proxyquire('../event-handler', {
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'SQS': MockSQSClient,
        'S3': MockS3Client,
        'SNS': MockSnsClient,
        // eslint-disable-next-line no-empty-function
        'config': { update: () => ({}) }
    },
    'ioredis': MockRedis,
    './persistence/rds': {
        'findHumanRefForUser': getHumanRefStub,
        'updateAccountTags': updateTagsStub,
        'updateTxTags': updateTxFlagsStub,
        'fetchAccountTagByPrefix': fetchBSheetAccStub,
        'getMinimalFriendListForUser': getFriendListStub,
        '@noCallThru': true
    },
    'publish-common': {
        'sendSms': sendSmsStub,
        'safeEmailSendPlain': sendEmailStub,
        'publishUserEvent': publishUserEventStub,
        '@noCallThru': true
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
        helper.resetStubs(
            lamdbaInvokeStub, getObjectStub, getQueueUrlStub, sqsSendStub, updateTagsStub, updateTxFlagsStub, 
            fetchBSheetAccStub, redisGetStub, redisSetStub, getHumanRefStub, sendEmailStub, sendSmsStub, publishUserEventStub
        );

        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'some-queue'}) });
        sqsSendStub.returns({ promise: () => 'SHOULD_NOT_HAPPEN'});
    });

    const commonAssertions = ({ resultOfHandle, investmentInvocation }) => {
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({
            Bucket: config.get('templates.bucket'), Key: config.get('templates.saveEmail')
        });
        expect(sendEmailStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.been.calledThrice; // for balance & for status & investment
        expect(lamdbaInvokeStub).to.have.been.calledWith(investmentInvocation);
        expect(fetchBSheetAccStub).to.have.been.calledOnce;
        expect(updateTxFlagsStub).to.have.been.calledOnce;
        expectNoCalls(getQueueUrlStub, sqsSendStub);
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

    it('Registers account with third party, persists account id from third party, connects or creates friend requests', async () => {
        const testUserId = uuid();
        const testClientId = uuid();
        const testFloatId = uuid();
        const testRequestId = uuid();
        const testUpdateTime = moment();
        const testNationalId = '0340450540345';
        const testCountryCode = 'FIJ';

        const notificationContacts = config.get('publishing.accountsPhoneNumbers');

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

        const bsheetInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createBalanceSheetAccount'), false, {
            idNumber: testUserProfile.nationalId,
            surname: testUserProfile.familyName,
            firstNames: testUserProfile.personalName,
            humanRef: 'MKZ0010'
        });

        // todo: bit of a code smell here but not significant enough to divert for the moment
        const boostPayload = { eventType: 'USER_CREATED_ACCOUNT', accountId: 'some-id', eventContext: { accountId: 'some-id' }};
        const boostInvocation = helper.wrapLambdaInvoc('boost_event_process', true, boostPayload);

        const testFriendRequests = [{ requestId: testRequestId }];
        const friendReqInvocation = helper.wrapLambdaInvoc(config.get('lambdas.connectFriendReferral'), false, { systemWideUserId: testUserId });

        sendSmsStub.resolves({ result: 'SUCCESS' });
        getHumanRefStub.resolves([{ humanRef: 'MKZ0010', accountId: 'some-id' }]);
        redisGetStub.onFirstCall().returns(JSON.stringify(testUserProfile));
        lamdbaInvokeStub.withArgs(bsheetInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ accountNumber: 'MKZ0010' }) })});
        lamdbaInvokeStub.withArgs(boostInvocation).returns({ promise: () => ({ StatusCode: 202 })});
        lamdbaInvokeStub.withArgs(friendReqInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testFriendRequests)})})});
        updateTagsStub.resolves({ updatedTime: testUpdateTime });

        const snsEvent = wrapEventSns({ userId: testUserId, eventType: 'USER_CREATED_ACCOUNT' });

        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);

        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(redisGetStub).to.have.been.calledOnceWithExactly(`USER_PROFILE::${testUserId}`);
        expect(getHumanRefStub).to.have.been.calledOnceWithExactly(testUserId);
        
        expect(lamdbaInvokeStub.callCount).to.equal(3);
        expect(lamdbaInvokeStub).to.have.been.calledWith(bsheetInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(boostInvocation);
        // expect(lamdbaInvokeStub).to.have.been.calledWith(friendReqInvocation);
        // expect(lamdbaInvokeStub).to.have.been.calledWith(createFriendInvocation);

        expect(updateTagsStub).to.have.been.calledOnceWithExactly(testUserId, 'FINWORKS::MKZ0010');
        notificationContacts.forEach((contact) => {
            expect(sendSmsStub).to.have.been.calledWith({ phoneNumber: contact, message: 'New Jupiter account opened. Human reference: MKZ0010' });
        });
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
            countryCode: testCountryCode,
            nationalId: testNationalId,
            userStatus: 'CREATED',
            kycStatus: 'CONTACT_VERIFIED',
            securedStatus: 'PASSWORD_SET',
            updatedTimeEpochMillis: moment().valueOf()
        };

        const userProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true });
        const FWAccCreationInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createBalanceSheetAccount'), false, {
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

    it('Handles saving initiation (EFT) correctly', async () => {
        const saveStartEvent = {
            userId: testId,
            eventType: 'SAVING_EVENT_INITIATED',
            timeInMillis: moment().valueOf(),
            context: {
                saveInformation: {
                    paymentProvider: 'MANUAL_ETF',
                    amount: 1000000,
                    currency: 'USD',
                    unit: 'HUNDREDTH_CENT'
                },
                initiationResult: {
                    humanReference: 'JSAVE101'
                }
            }
        };

        // we just need the user status
        const testProfile = { body: JSON.stringify({ personalName: 'John', familyName: 'Nkomo', userStatus: 'ACCOUNT_OPENED' }) };
        redisGetStub.withArgs(`USER_PROFILE::${testId}`).resolves(null);
        const userProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testId, includeContactMethod: false });
        lamdbaInvokeStub.withArgs(userProfileInvocation).returns({ promise: () => ({ Payload: JSON.stringify(testProfile) }) });

        const statusInstruct = { systemWideUserId: testId, updatedUserStatus: { changeTo: 'USER_HAS_INITIATED_SAVE', reasonToLog: 'Saving event started' }};
        const statusUpdateInvoke = helper.wrapLambdaInvoc('profile_status_update', true, statusInstruct);
        lamdbaInvokeStub.withArgs(statusUpdateInvoke).returns({ promise: () => ({ StatusCode: 202 })});

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'This is an email template' }})});
        sendEmailStub.resolves({ result: 'SUCCESS' });

        const resultOfCall = await eventHandler.handleUserEvent(wrapEventSns(saveStartEvent));
        expect(resultOfCall).to.deep.equal({ statusCode: 200 }); 
    });

    // extremely complicated. even for its author. todo : split this thing so it is possible to debug without as much pain.
    it('Handles saving event happy path correctly', async () => {
        const testAccountId = uuid();
        const testAccountNumber = 'POL1';
        const timeNow = moment().valueOf();
        const testUpdateTime = moment();

        const activeStubs = [lamdbaInvokeStub, getObjectStub, sendEmailStub, updateTxFlagsStub, fetchBSheetAccStub];

        const configureStubs = (bsheetInvocation) => {
            lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
            lamdbaInvokeStub.withArgs(bsheetInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ result: 'ADDED' })})});

            getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'This is an email template' }})});
            sendEmailStub.resolves({ result: 'SUCCESS' });
            
            fetchBSheetAccStub.resolves('POL1');
            updateTxFlagsStub.resolves({ updatedTime: testUpdateTime });
        };

        let investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.addTxToBalanceSheet'), false, {
            operation: 'INVEST',
            transactionDetails: { accountNumber: testAccountNumber, amount: 100, unit: 'WHOLE_CURRENCY', currency: 'USD' }
        });
        
        configureStubs(investmentInvocation);
        
        const savingEvent = {
            userId: testId,
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            timeInMillis: timeNow,
            context: {
                accountId: testAccountId,
                saveCount: 10,
                savedAmount: '1000000::HUNDREDTH_CENT::USD'
            }
        };

        // minor variations in calls, hence the aggregation
        let resultOfHandle = await eventHandler.handleUserEvent(wrapEventSns(savingEvent));
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.saveCount = 2; // special case of 1 is tested below properly
        configureStubs(investmentInvocation);
        sendEmailStub.resolves({ result: 'FAILURE' });
        resultOfHandle = await eventHandler.handleUserEvent(wrapEventSns(savingEvent));
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.saveCount = 2;
        configureStubs(investmentInvocation);
        resultOfHandle = await eventHandler.handleUserEvent(wrapEventSns(savingEvent));
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        savingEvent.context.saveCount = 3;
        savingEvent.context.savedAmount = '1000000::HUNDREDTH_CENT::ZAR';
        investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.addTxToBalanceSheet'), false, {
            operation: 'INVEST',
            transactionDetails: { accountNumber: testAccountNumber, amount: 100, unit: 'WHOLE_CURRENCY', currency: 'ZAR' }
        });

        configureStubs(investmentInvocation);
        resultOfHandle = await eventHandler.handleUserEvent(wrapEventSns(savingEvent));
        commonAssertions({ resultOfHandle, investmentInvocation });
        helper.resetStubs(...activeStubs);

        // todo : this should actually throw an error
        savingEvent.context.savedAmount = '::::';
        investmentInvocation = helper.wrapLambdaInvoc(config.get('lambdas.addTxToBalanceSheet'), false, {
            operation: 'INVEST',
            transactionDetails: { accountNumber: testAccountNumber, amount: null, unit: 'WHOLE_CURRENCY', currency: '' }
        });
        configureStubs(investmentInvocation);
        const resultOfBadAmount = await eventHandler.handleUserEvent(wrapEventSns(savingEvent));
        logger('Result:', resultOfBadAmount);
        expect(resultOfBadAmount).to.deep.equal({ statusCode: 500 });

        expect(lamdbaInvokeStub).to.have.been.calledThrice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(investmentInvocation);
        expect(fetchBSheetAccStub).to.have.been.calledOnce;
        expect(updateTxFlagsStub).to.have.been.calledOnce;
        expect(sendEmailStub).to.have.not.been.called;
        expect(sqsSendStub).to.have.been.calledOnce;
        expect(publishUserEventStub).to.not.have.been.called;
    });

    it('Handles withdrawal event happy path correctly', async () => {
        const timeNow = moment().valueOf();
        const testAccountId = uuid();

        // we just need the names and contact method
        const testProfile = { personalName: 'John', familyName: 'Nkomo', emailAddress: 'someone@jupitersave.com' };
        redisGetStub.withArgs(`USER_PROFILE::${testId}`).resolves(null);
        const userProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testId, includeContactMethod: true });

        const cachedBankDetails = { account: 'Hello' };
        const expectedBankDetails = { account: 'Hello', accountHolder: 'John Nkomo' };

        redisGetStub.withArgs(`WITHDRAWAL_DETAILS::${testId}`).resolves(JSON.stringify(cachedBankDetails));
        lamdbaInvokeStub.withArgs(userProfileInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testProfile)})})});

        getObjectStub.returns({ promise: () => ({ 
            Body: { toString: () => 'This is an email template' }
        })});
        sendEmailStub.returns({ promise: () => 'Email sent' });

        const boostProcessPayload = {
            eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            timeInMillis: timeNow,
            accountId: testAccountId,
            eventContext: { accountId: testAccountId, withdrawalAmount: '100::WHOLE_CURRENCY::USD' }
        };
        const boostProcessInvocation = helper.wrapLambdaInvoc('boost_event_process', true, boostProcessPayload);
        lamdbaInvokeStub.withArgs(boostProcessInvocation).returns({ promise: () => ({ StatusCode: 202 })});

        fetchBSheetAccStub.resolves('POL1');
        const bsheetInvocation = helper.wrapLambdaInvoc(config.get('lambdas.addTxToBalanceSheet'), false, {
            operation: 'WITHDRAW',
            transactionDetails: { accountNumber: 'POL1', amount: 100, unit: 'WHOLE_CURRENCY', currency: 'USD', bankDetails: expectedBankDetails }
        });
        const bsheetResult = { result: 'WITHDRAWN' };
        lamdbaInvokeStub.withArgs(bsheetInvocation).returns({ promise: () => ({ Payload: JSON.stringify(bsheetResult)})});

        const statusInstruct = { systemWideUserId: testId, updatedUserStatus: { changeTo: 'USER_HAS_WITHDRAWN', reasonToLog: 'User withdrew funds' }};
        const statusUpdateInvoke = helper.wrapLambdaInvoc('profile_status_update', true, statusInstruct);
        lamdbaInvokeStub.withArgs(statusUpdateInvoke).returns({ promise: () => ({ StatusCode: 202 })});
        
        const withdrawalEvent = {
            userId: testId,
            eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            timeInMillis: timeNow,
            context: {
                accountId: testAccountId,
                withdrawalAmount: '100::WHOLE_CURRENCY::USD'
            }
        };

        const snsEvent = wrapEventSns(withdrawalEvent);
        const resultOfHandle = await eventHandler.handleUserEvent(snsEvent);

        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWithExactly(`WITHDRAWAL_DETAILS::${testId}`);
        expect(redisGetStub).to.have.been.calledWithExactly(`USER_PROFILE::${testId}`);
        expect(redisSetStub).to.have.been.calledOnceWithExactly(`USER_PROFILE::${testId}`, JSON.stringify(testProfile), 'EX', 25200);
        
        expect(getObjectStub).to.have.been.
            calledOnceWithExactly({ Bucket: config.get('templates.bucket'), Key: config.get('templates.withdrawalEmail') });
        expect(sendEmailStub).to.have.been.calledOnce;

        expect(lamdbaInvokeStub).to.have.been.called;
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(userProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(boostProcessInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(bsheetInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(statusUpdateInvoke);
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
        expect(fetchBSheetAccStub).to.have.not.been.called;
        expect(updateTxFlagsStub).to.have.not.been.called;
        expect(getQueueUrlStub).to.have.been.calledOnce;
        expect(sqsSendStub).to.have.been.calledOnce;
    });

    it('Handles friendship event properly', async () => {
        const testInitiatingUserId = 'some-user';
        const testAcceptingUserId = 'another-user';

        const friendshipEventInitiated = { userId: testInitiatingUserId, eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED' };
        const friendshipEventAccepting = { userId: testAcceptingUserId, eventType: 'FRIEND_REQUEST_TARGET_ACCEPTED' };

        const mockConnectionTime = moment().subtract(3, 'seconds');
        const mockFriendship = { relationshipId: 'friends-id', creationTime: mockConnectionTime, initiatedUserId: testInitiatingUserId };

        const mockFriendshipList = (userId) => [{ relationshipId: 'friends-id', creationTimeMillis: mockConnectionTime.valueOf(), userInitiated: userId === testInitiatingUserId }];
        const mockBoostEvent = ({ eventType, userId }) => ({ userId, eventType, eventContext: { friendshipList: mockFriendshipList(userId) } });

        getFriendListStub.resolves([mockFriendship]);
        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});

        const resultOfInitiatedHandle = await eventHandler.handleUserEvent(wrapEventSns(friendshipEventInitiated));
        const resultOfAcceptedHandle = await eventHandler.handleUserEvent(wrapEventSns(friendshipEventAccepting));

        expect(resultOfInitiatedHandle).to.deep.equal({ statusCode: 200 });
        expect(resultOfAcceptedHandle).to.deep.equal({ statusCode: 200 });

        expect(getFriendListStub).to.have.been.calledTwice;
        expect(getFriendListStub).to.have.been.calledWithExactly(testInitiatingUserId);
        expect(getFriendListStub).to.have.been.calledWithExactly(testAcceptingUserId);

        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        const expectedInvokeAccepted = helper.wrapLambdaInvoc('boost_event_process', true, mockBoostEvent(friendshipEventInitiated));
        const expectedInvokeInitiated = helper.wrapLambdaInvoc('boost_event_process', true, mockBoostEvent(friendshipEventAccepting));
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedInvokeAccepted);
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedInvokeInitiated);
    });

});
