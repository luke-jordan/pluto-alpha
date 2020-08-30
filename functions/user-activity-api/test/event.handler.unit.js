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
const snsPublishStub = sinon.stub();
const getQueueUrlStub = sinon.stub();

const sendEmailStub = sinon.stub();
const sendSmsStub = sinon.stub();
const addToDlqStub = sinon.stub();

const getHumanRefStub = sinon.stub();
const updateTagsStub = sinon.stub();
const updateTxFlagsStub = sinon.stub();
const fetchBSheetAccStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const sumAccountBalanceStub = sinon.stub();
const getFriendListStub = sinon.stub();

const publishUserEventStub = sinon.stub();
const sendEventToQueueStub = sinon.stub();

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
        'findHumanRefForUser': getHumanRefStub,
        'updateAccountTags': updateTagsStub,
        'updateTxTags': updateTxFlagsStub,
        'fetchAccountTagByPrefix': fetchBSheetAccStub,
        'getMinimalFriendListForUser': getFriendListStub,
        'fetchTransaction': fetchTransactionStub,
        'sumAccountBalance': sumAccountBalanceStub,
        '@noCallThru': true
    },
    'publish-common': {
        'sendSms': sendSmsStub,
        'sendSystemEmail': sendEmailStub,
        'publishUserEvent': publishUserEventStub,
        'sendToQueue': sendEventToQueueStub,
        'addToDlq': addToDlqStub,
        '@noCallThru': true
    }
});

const wrapEventSqs = (event) => ({
    Records: [{ body: JSON.stringify({ Message: JSON.stringify(event) }) }]
});

const expectNoCalls = (...stubs) => {
    stubs.forEach((stub) => expect(stub).to.not.have.been.called);  
};

const resetStubs = () => helper.resetStubs(
    lamdbaInvokeStub, getQueueUrlStub, updateTagsStub, updateTxFlagsStub, fetchBSheetAccStub, fetchTransactionStub,
    redisGetStub, redisSetStub, getHumanRefStub, sumAccountBalanceStub, sendEmailStub, sendSmsStub, 
    publishUserEventStub, sendEventToQueueStub, addToDlqStub
);

const mockUserId = uuid();

describe('*** UNIT TESTING EVENT HANDLING HAPPY PATHS ***', () => {

    beforeEach(() => {
        resetStubs();
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'some-queue'}) });
    });

    it('Handles non-special (e.g., login) event properly', async () => {
        const snsEvent = wrapEventSqs({ userId: mockUserId, eventType: 'USER_LOGIN' });
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(snsEvent);
        logger('Result: ', resultOfHandle);
        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal([{ statusCode: 200 }]);
        expectNoCalls(lamdbaInvokeStub, sendEventToQueueStub, sendEmailStub, redisGetStub);
    });

    it('Ignores one among multiple account open events properly', async () => {
        const snsEvent = wrapEventSqs({ userId: mockUserId, eventType: 'PASSWORD_SET' });
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(snsEvent);
        expect(resultOfHandle).to.deep.equal([{ statusCode: 200 }]); // for now
        expectNoCalls(lamdbaInvokeStub, sendEventToQueueStub, sendEmailStub, redisGetStub);
    });

    it('Registers account with third party, persists account id from third party, connects or creates friend requests', async () => {
        const testUserId = uuid();
        const testMoment = moment();

        const testClientId = 'some-client-id';
        const testFloatId = 'a-float';
        const testNationalId = '0340450540345';
        const testCountryCode = 'FIJ';

        const testRequestId = uuid();

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
            kycStatus: 'FAILED_VERIFICATION',
            securedStatus: 'PASSWORD_SET',
            updatedTimeEpochMillis: moment().valueOf()
        };

        const testFriendRequests = [{ requestId: testRequestId }];
        const friendReqPayload = { targetUserId: testUserId, countryCode: 'FIJ', emailAddress: 'mencius@confucianism.com', phoneNumber: '16061110000' };
        const friendReqInvocation = helper.wrapLambdaInvoc(config.get('lambdas.connectFriendReferral'), true, friendReqPayload);

        sendSmsStub.resolves({ result: 'SUCCESS' });
        redisGetStub.onFirstCall().returns(JSON.stringify(testUserProfile));
        getHumanRefStub.resolves([{ humanRef: 'MKZ0010', accountId: 'some-id', tags: [] }]);

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
        lamdbaInvokeStub.withArgs(friendReqInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testFriendRequests)})})});

        const sqsEvent = wrapEventSqs({ userId: testUserId, eventType: 'USER_CREATED_ACCOUNT', timestamp: testMoment.valueOf() });
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsEvent);
        expect(resultOfHandle).to.deep.equal([{ statusCode: 200 }]);

        expect(redisGetStub).to.have.been.calledOnceWithExactly(`USER_PROFILE::${testUserId}`);
        expect(getHumanRefStub).to.have.been.calledOnceWithExactly(testUserId);
        
        expect(lamdbaInvokeStub).to.have.been.calledOnceWith(friendReqInvocation);

        const boostPayload = { eventType: 'USER_CREATED_ACCOUNT', userId: testUserId, accountId: 'some-id', eventContext: { accountId: 'some-id' }, timeInMillis: testMoment.valueOf() };
        expect(sendEventToQueueStub).to.have.been.calledOnceWith('boost_process_queue', [boostPayload]);

        notificationContacts.forEach((contact) => {
            expect(sendSmsStub).to.have.been.calledWith({ phoneNumber: contact, message: 'New Jupiter account opened. Human reference: MKZ0010' });
        });
        expect(getQueueUrlStub).to.have.not.been.called;
    });

    it('Account open creates balance sheet account if KYC already verified', async () => {
        const testUserId = uuid();
        const testMoment = moment();

        const testUserProfile = {
            systemWideUserId: testUserId,
            creationTimeEpochMillis: moment().valueOf(),
            personalName: 'Meng',
            familyName: 'Ke',
            emailAddress: 'mencius@confucianism.com',
            kycStatus: 'VERIFIED_AS_PERSON'
        };

        redisGetStub.onFirstCall().returns(JSON.stringify(testUserProfile));
        getHumanRefStub.resolves([{ humanRef: 'MKZ0010', accountId: 'some-id', tags: [] }]);
        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ accountNumber: 'MKZ0010' }) })});
        
        const accountEvent = { userId: testUserId, eventType: 'USER_CREATED_ACCOUNT', timestamp: testMoment.valueOf() };
        const resultOfHandle = await eventHandler.handleUserEvent(accountEvent);

        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(redisGetStub).to.have.been.calledOnceWithExactly(`USER_PROFILE::${testUserId}`);
        expect(getHumanRefStub).to.have.been.calledOnceWithExactly(testUserId);
    
        // note: balance sheet account _open_ is currently still via lambda event
        expect(lamdbaInvokeStub).to.have.been.calledTwice; // friendship call content covered above

        const bsheetInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createBalanceSheetAccount'), false, {
            idNumber: testUserProfile.nationalId,
            surname: testUserProfile.familyName,
            firstNames: testUserProfile.personalName,
            humanRef: 'MKZ0010'
        });
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(bsheetInvocation);

        expect(sendEventToQueueStub).to.have.been.calledOnce; // call payload is above
    });

    it('Creates balance sheet account after KYC verification, if not done prior', async () => {
        const testUserId = uuid();
        const testNationalId = 'some-national-id';
        const testUpdateTime = moment();

        const testUserProfile = {
            systemWideUserId: testUserId,
            creationTimeEpochMillis: moment().valueOf(),
            personalName: 'Meng',
            familyName: 'Ke',
            phoneNumber: '16061110000',
            nationalId: testNationalId
        };

        const bsheetInvocation = helper.wrapLambdaInvoc(config.get('lambdas.createBalanceSheetAccount'), false, {
            idNumber: testUserProfile.nationalId,
            surname: testUserProfile.familyName,
            firstNames: testUserProfile.personalName,
            humanRef: 'MKZ0010'
        });

        redisGetStub.onFirstCall().returns(JSON.stringify(testUserProfile));
        getHumanRefStub.resolves([{ humanRef: 'MKZ0010', accountId: 'some-id', tags: [] }]);
        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ accountNumber: 'MKZ0010' }) })});
        updateTagsStub.resolves({ updatedTime: testUpdateTime });

        const accountEvent = { userId: testUserId, eventType: 'VERIFIED_AS_PERSON' };
        const resultOfHandle = await eventHandler.handleUserEvent(accountEvent);
        expect(resultOfHandle).to.exist;

        expect(getHumanRefStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(bsheetInvocation);
        expect(updateTagsStub).to.have.been.calledOnceWithExactly(testUserId, 'FINWORKS::MKZ0010');
        expect(redisGetStub).to.have.been.calledOnce; // args covered above
    });

    // todo: watch out for race condition if multiple events arrive at once for same user (i.e., account open & kyc)
    it('Skips balance sheet creation if already exists', async () => {
        const testUserId = uuid();

        const testUserProfile = {
            systemWideUserId: testUserId,
            emailAddress: 'mencius@confucianism.com'
        };

        redisGetStub.onFirstCall().returns(JSON.stringify(testUserProfile));
        getHumanRefStub.resolves([{ humanRef: 'MKZ0010', accountId: 'some-id', tags: ['FINWORKS::MKZ0010'] }]);

        const sqsEvent = wrapEventSqs({ userId: testUserId, eventType: 'VERIFIED_AS_PERSON' });
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsEvent);
        expect(resultOfHandle).to.exist;

        expect(getHumanRefStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(lamdbaInvokeStub).to.not.have.been.called;
        expect(updateTagsStub).to.not.have.been.called;
        expect(redisGetStub).to.have.been.calledOnce; // args covered above
    });

    it('Catches third party errors, => DLQ', async () => {
        const testUserId = uuid();
        const testClientId = uuid();
        const testFloatId = uuid();
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


        getHumanRefStub.resolves([{ accountId: 'some-id', tags: [] }]); // ie some error removes human ref
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testUserProfile)})})});        
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ statusCode: 500 })})})});
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});

        const sqsEvent = wrapEventSqs({ userId: testUserId, eventType: 'VERIFIED_AS_PERSON' });
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsEvent);
        logger('Result of acc creation on third party error:', resultOfHandle);

        expect(resultOfHandle).to.exist;
        expect(resultOfHandle).to.deep.equal([{ statusCode: 500 }]);
        expect(lamdbaInvokeStub).to.have.been.calledWith(userProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(FWAccCreationInvocation);
        expect(updateTagsStub).to.have.not.been.called;
        expect(addToDlqStub).to.have.been.calledOnce;
    });

});

describe('*** UNIT TEST SAVING EVENT HANDLING ***', () => {

    beforeEach(resetStubs);

    const testAccountId = uuid();
    const timeNow = moment().valueOf();
    const testUpdateTime = moment();

    const mockSavingEvent = {
        userId: mockUserId,
        eventType: 'SAVING_PAYMENT_SUCCESSFUL',
        timeInMillis: timeNow,
        context: {
            accountId: testAccountId,
            saveCount: 10,
            savedAmount: '1000000::HUNDREDTH_CENT::USD'
        }
    };

    const setStubsForSaveComplete = (operation, transactionDetails) => {
        const bsheetInvocation = {
            FunctionName: config.get('lambdas.addTxToBalanceSheet'), 
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({ operation, transactionDetails })
        };

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 202 })});
        lamdbaInvokeStub.withArgs(bsheetInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ result: 'ADDED' })})});

        sendEmailStub.resolves({ result: 'SUCCESS' });
        
        fetchBSheetAccStub.resolves('POL1');
        updateTxFlagsStub.resolves({ updatedTime: testUpdateTime });
    };

    // todo : add argument coverage
    const commonAssertions = (resultOfHandle) => {
        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
        expect(sendEmailStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.been.calledOnce; // for status
        expect(sendEventToQueueStub).to.have.been.calledTwice; // for boost and for balance sheet
        expect(fetchBSheetAccStub).to.have.been.calledOnce;
        expect(updateTxFlagsStub).to.have.been.calledOnce;
        expectNoCalls(getQueueUrlStub);
    };

    const extractQueuePayload = (queueName) => {
        const relevantCall = sendEventToQueueStub.getCalls().find((call) => call.args[0] === queueName);
        return relevantCall.args[1][0];
    };

    it('Handles saving initiation (EFT) correctly', async () => {
        const saveStartEvent = {
            userId: mockUserId,
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
        redisGetStub.withArgs(`USER_PROFILE::${mockUserId}`).resolves(null);
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => ({ Payload: JSON.stringify(testProfile) }) });

        const statusInstruct = { systemWideUserId: mockUserId, updatedUserStatus: { changeTo: 'USER_HAS_INITIATED_SAVE', reasonToLog: 'Saving event started' }};
        const statusUpdateInvoke = helper.wrapLambdaInvoc('profile_status_update', true, statusInstruct);
        lamdbaInvokeStub.withArgs(statusUpdateInvoke).returns({ promise: () => ({ StatusCode: 202 })});

        sendEmailStub.resolves({ result: 'SUCCESS' });

        const resultOfCall = await eventHandler.handleUserEvent(saveStartEvent);
        expect(resultOfCall).to.deep.equal({ statusCode: 200 });

        const userProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: mockUserId, includeContactMethod: false });
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(userProfileInvocation);
    });

    it('Handles saving event happy path correctly', async () => {
        const testAccountNumber = 'POL1';

        fetchTransactionStub.resolves({ settlementTime: moment().subtract(1, 'second') });
        sumAccountBalanceStub.onFirstCall().resolves({ amount: 200 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD' });
        sumAccountBalanceStub.onSecondCall().resolves({ amount: 300 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD' });

        setStubsForSaveComplete('INVEST', { accountNumber: testAccountNumber, amount: 100, unit: 'WHOLE_CURRENCY', currency: 'USD' });
        
        const savingEvent = { ...mockSavingEvent };
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(wrapEventSqs(savingEvent));
        commonAssertions(resultOfHandle[0]);

        const boostLambdaPayload = extractQueuePayload('boost_process_queue');
        expect(boostLambdaPayload.eventContext).to.deep.equal({
            accountId: testAccountId,
            saveCount: mockSavingEvent.context.saveCount,
            savedAmount: mockSavingEvent.context.savedAmount,
            preSaveBalance: '2000000::HUNDREDTH_CENT::USD',
            postSaveBalance: '3000000::HUNDREDTH_CENT::USD'
        });
    });

    it('Swallows email failure', async () => {
        const savingEvent = { ...mockSavingEvent };
        savingEvent.context.saveCount = 2; // special case of 1 is tested elsewhere

        fetchTransactionStub.resolves({ settlementTime: moment().subtract(1, 'second') });
        sumAccountBalanceStub.onFirstCall().resolves({ amount: 200 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD' });
        sumAccountBalanceStub.onSecondCall().resolves({ amount: 300 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'USD' });
        
        const bsheetPayload = { accountNumber: 'POL1', amount: 100, unit: 'WHOLE_CURRENCY', currency: 'USD' };
        setStubsForSaveComplete('INVEST', bsheetPayload);
        
        sendEmailStub.resolves({ result: 'FAILURE' });
        
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(wrapEventSqs(savingEvent));
        commonAssertions(resultOfHandle[0]);
    });

    it('Passes currencies through properly and account numbers', async () => {
        const savingEvent = { ...mockSavingEvent };
        savingEvent.context.saveCount = 3;
        savingEvent.context.savedAmount = '1000000::HUNDREDTH_CENT::ZAR';
        const bsheetPayload = { accountNumber: 'APERSON', amount: 100, unit: 'WHOLE_CURRENCY', currency: 'ZAR' };

        fetchTransactionStub.resolves({ settlementTime: moment().subtract(1, 'second') });
        sumAccountBalanceStub.onFirstCall().resolves({ amount: 250 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });
        sumAccountBalanceStub.onSecondCall().resolves({ amount: 350 * 100 * 100, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        setStubsForSaveComplete('INVEST', bsheetPayload);
        fetchBSheetAccStub.resolves('APERSON');

        const resultOfHandle = await eventHandler.handleUserEvent(savingEvent);
        commonAssertions(resultOfHandle);

        const boostLambdaPayload = extractQueuePayload('boost_process_queue');
        expect(boostLambdaPayload.eventContext).to.deep.equal({
            accountId: testAccountId,
            saveCount: 3,
            savedAmount: '1000000::HUNDREDTH_CENT::ZAR',
            preSaveBalance: '2500000::HUNDREDTH_CENT::ZAR',
            postSaveBalance: '3500000::HUNDREDTH_CENT::ZAR'
        });
    });

    it('Does not process on empty amount', async () => {
        const savingEvent = { ...mockSavingEvent };
        savingEvent.context.savedAmount = '::::';

        const resultOfBadAmount = await eventHandler.handleUserEvent(savingEvent);
        expect(resultOfBadAmount).to.deep.equal({ statusCode: 500 });

        expect(addToDlqStub).to.have.been.calledOnce;
        expect(sendEmailStub).to.not.have.been.called;
        expect(fetchBSheetAccStub).to.not.have.been.called;
        expect(lamdbaInvokeStub).to.not.have.been.called;
        expect(publishUserEventStub).to.not.have.been.called;
    });

});

describe('*** UNIT TEST WITHDRAWAL, FRIENDSHIP, BOOST EVENTS ***', () => {

    beforeEach(resetStubs);

    it('Handles withdrawal event happy path correctly', async () => {
        const timeNow = moment().valueOf();
        const testAccountId = uuid();

        // we just need the names and contact method
        const testProfile = { personalName: 'John', familyName: 'Nkomo', emailAddress: 'someone@jupitersave.com' };
        redisGetStub.withArgs(`USER_PROFILE::${mockUserId}`).resolves(null);
        const userProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: mockUserId, includeContactMethod: true });

        const cachedBankDetails = { account: 'Hello' };
        const expectedBankDetails = { account: 'Hello', accountHolder: 'John Nkomo' };

        redisGetStub.withArgs(`WITHDRAWAL_DETAILS::${mockUserId}`).resolves(JSON.stringify(cachedBankDetails));
        lamdbaInvokeStub.withArgs(userProfileInvocation).returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify(testProfile)})})});

        sendEmailStub.resolves({ result: 'SUCCESS' });

        const boostProcessPayload = {
            userId: mockUserId,
            eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            timeInMillis: timeNow,
            accountId: testAccountId,
            eventContext: { accountId: testAccountId, transactionId: 'transaction-X', withdrawalAmount: '100::WHOLE_CURRENCY::USD' }
        };

        fetchBSheetAccStub.resolves('POL1');
        const bsheetPayload = {
            operation: 'WITHDRAW',
            transactionDetails: { accountNumber: 'POL1', amount: 100, unit: 'WHOLE_CURRENCY', currency: 'USD', bankDetails: expectedBankDetails, transactionId: 'transaction-X' }
        };

        // todo : error handling proper tests
        sendEventToQueueStub.resolves({ result: 'SUCCESS '});

        const statusInstruct = { systemWideUserId: mockUserId, updatedUserStatus: { changeTo: 'USER_HAS_WITHDRAWN', reasonToLog: 'User withdrew funds' }};
        const statusUpdateInvoke = helper.wrapLambdaInvoc('profile_status_update', true, statusInstruct);
        lamdbaInvokeStub.withArgs(statusUpdateInvoke).returns({ promise: () => ({ StatusCode: 202 })});
        
        const withdrawalEvent = {
            userId: mockUserId,
            eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            timestamp: timeNow,
            context: {
                accountId: testAccountId,
                transactionId: 'transaction-X',
                withdrawalAmount: '100::WHOLE_CURRENCY::USD'
            }
        };

        const sqsBatch = wrapEventSqs(withdrawalEvent);
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsBatch);

        expect(resultOfHandle).to.deep.equal([{ statusCode: 200 }]);
        
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisGetStub).to.have.been.calledWithExactly(`WITHDRAWAL_DETAILS::${mockUserId}`);
        expect(redisGetStub).to.have.been.calledWithExactly(`USER_PROFILE::${mockUserId}`);
        expect(redisSetStub).to.have.been.calledOnceWithExactly(`USER_PROFILE::${mockUserId}`, JSON.stringify(testProfile), 'EX', 25200);
        
        expect(sendEmailStub).to.have.been.calledOnce; // todo : coverage

        expect(lamdbaInvokeStub).to.have.callCount(2);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(userProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(statusUpdateInvoke);

        expect(sendEventToQueueStub).to.have.been.calledTwice;
        expect(sendEventToQueueStub).to.have.been.calledWithExactly('boost_process_queue', [boostProcessPayload], true);
        expect(sendEventToQueueStub).to.have.been.calledWithExactly('balance_sheet_update_queue', [bsheetPayload], true);
    });
    
    // bit of boilerplate in what follows, but pretty crucial that these get routed properly
    it('Dispatches admin settled withdrawal to boost processing', async () => {
        const timeNow = moment().valueOf();

        const boostProcessPayload = {
            userId: mockUserId,
            eventType: 'ADMIN_SETTLED_WITHDRAWAL',
            timeInMillis: timeNow,
            accountId: 'account-id',
            eventContext: { accountId: 'account-id' } // actually quite a lot more in here, but not relevant to this purpose
        };

        const withdrawalEvent = {
            userId: mockUserId,
            eventType: 'ADMIN_SETTLED_WITHDRAWAL',
            timestamp: timeNow,
            initiator: 'some-admin-id',
            context: { accountId: 'account-id' }
        };

        const sqsBatch = wrapEventSqs(withdrawalEvent);
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsBatch);
        expect(resultOfHandle).to.exist;

        expect(sendEventToQueueStub).to.have.been.calledWithExactly('boost_process_queue', [boostProcessPayload], true);
    });

    it('Catches thrown errors, sends failed processes to DLQ', async () => {
        const testAccountId = uuid();
        const timeNow = moment().valueOf();

        lamdbaInvokeStub.throws(new Error('Negative contact'));
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'test/queue/url' })});
        addToDlqStub.resolves({ result: 'SENT' });

        const savingEvent = {
            userId: mockUserId,
            eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            timeInMillis: timeNow,
            context: {
                accountId: testAccountId,
                saveCount: 10,
                savedAmount: '100::WHOLE_CURRENCY::ZAR'
            }
        };

        const sqsBatch = wrapEventSqs(savingEvent);
        const resultOfHandle = await eventHandler.handleBatchOfQueuedEvents(sqsBatch);
        logger('Result of investment on error:', resultOfHandle);

        expect(resultOfHandle).to.deep.equal([{ statusCode: 500 }]);
        expect(lamdbaInvokeStub).to.have.been.calledOnce;
        expect(sendEmailStub).to.have.not.been.called;
        expect(fetchBSheetAccStub).to.have.not.been.called;
        expect(updateTxFlagsStub).to.have.not.been.called;
        expect(addToDlqStub).to.have.been.calledOnce;
    });

    it('Handles friendship event properly', async () => {
        const testInitiatingUserId = 'some-user';
        const testAcceptingUserId = 'another-user';

        const mockTime = moment();

        const friendshipEventInitiated = { userId: testInitiatingUserId, eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED', timestamp: mockTime.valueOf() };
        const friendshipEventAccepting = { userId: testAcceptingUserId, eventType: 'FRIEND_REQUEST_TARGET_ACCEPTED', timestamp: mockTime.valueOf() };

        const mockConnectionTime = moment().subtract(3, 'seconds');
        const mockFriendship = { relationshipId: 'friends-id', creationTime: mockConnectionTime, initiatedUserId: testInitiatingUserId };

        const mockFriendshipList = (userId) => [{ relationshipId: 'friends-id', creationTimeMillis: mockConnectionTime.valueOf(), userInitiated: userId === testInitiatingUserId }];
        const mockBoostEvent = ({ eventType, userId }) => ({ userId, eventType, timeInMillis: mockTime.valueOf(), eventContext: { friendshipList: mockFriendshipList(userId) } });

        getFriendListStub.resolves([mockFriendship]);
        sendEventToQueueStub.returns({ promise: () => ({ StatusCode: 202 })});

        const sqsEventRecord = (event) => ({ body: JSON.stringify({ Message: JSON.stringify(event) })});
        const sqsFriendshipBatch = {
            Records: [sqsEventRecord(friendshipEventAccepting), sqsEventRecord(friendshipEventInitiated)]
        };
        
        const resultOfInitiatedHandle = await eventHandler.handleBatchOfQueuedEvents(sqsFriendshipBatch);

        expect(resultOfInitiatedHandle).to.deep.equal([{ statusCode: 200 }, { statusCode: 200 }]);

        expect(getFriendListStub).to.have.been.calledTwice;
        expect(getFriendListStub).to.have.been.calledWithExactly(testInitiatingUserId);
        expect(getFriendListStub).to.have.been.calledWithExactly(testAcceptingUserId);

        expect(sendEventToQueueStub).to.have.been.calledTwice;
        expect(sendEventToQueueStub).to.have.been.calledWith('boost_process_queue', [mockBoostEvent(friendshipEventInitiated)], true);
        expect(sendEventToQueueStub).to.have.been.calledWith('boost_process_queue', [mockBoostEvent(friendshipEventAccepting)], true);
        
        // const expectedInvokeAccepted = helper.wrapLambdaInvoc('boost_event_process', true, mockBoostEvent(friendshipEventInitiated));
        // const expectedInvokeInitiated = helper.wrapLambdaInvoc('boost_event_process', true, mockBoostEvent(friendshipEventAccepting));
        // expect(lamdbaInvokeStub).to.have.been.calledWith(expectedInvokeAccepted);
        // expect(lamdbaInvokeStub).to.have.been.calledWith(expectedInvokeInitiated);
    });

});
