'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const sendSmsStub = sinon.stub();
const redisGetStub = sinon.stub();
const sendEmailStub = sinon.stub();

const getFriendsStub = sinon.stub();
const randomWordStub = sinon.stub();
const connectUserStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchRequestStub = sinon.stub();
const fetchAccountStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const ignoreRequestStub = sinon.stub();
const fetchAllRequestsStub = sinon.stub();
const fetchActiveCodesStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const countMutualFriendsStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testLogId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
const testRequestId = uuid();

class MockRedis {
    constructor () { 
        this.mget = redisGetStub;
    }
}

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../friend-handler', {
    './persistence/read.friends': {
        'fetchFriendRequestsForUser': fetchAllRequestsStub,
        'fetchActiveRequestCodes': fetchActiveCodesStub,
        'fetchFriendshipRequestById': fetchRequestStub,
        'fetchAccountIdForUser': fetchAccountStub,
        'fetchActiveSavingFriendsForUser': getFriendsStub,
        'countMutualFriends': countMutualFriendsStub,
        'fetchUserProfile': fetchProfileStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        'connectUserToFriendRequest': connectUserStub,
        'ignoreFriendshipRequest': ignoreRequestStub,
        'insertFriendRequest': insertFriendRequestStub,
        'insertFriendship': insertFriendshipStub,
        'deactivateFriendship': deactivateFriendshipStub,
        '@noCallThru': true
    },
    'publish-common': {
        'sendSystemEmail': sendEmailStub,
        'sendSms': sendSmsStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'ioredis': MockRedis,
    'random-words': randomWordStub
});

const resetStubs = () => helper.resetStubs(getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub,
    deactivateFriendshipStub, fetchActiveCodesStub, fetchRequestStub, randomWordStub, sendEmailStub, sendSmsStub, connectUserStub,
    fetchAllRequestsStub, ignoreRequestStub, fetchAccountStub, lamdbaInvokeStub, redisGetStub);


describe('*** UNIT TEST FRIEND REQUEST INSERTION ***', () => {

    const testProfile = {
        systemWideUserId: testInitiatedUserId,
        personalName: 'Yao',
        familyName: 'Shu',
        phoneNumber: '02130940334',
        calledName: 'Yao Shu',
        emailAddress: 'yaoshu@orkhon.com'
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friend request', async () => {
        const requestedShareItems = ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'];
        const insertArgs = { initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId, requestedShareItems };
        const testEvent = helper.wrapParamsWithPath({ targetUserId: testTargetUserId, requestedShareItems }, 'initiate', testInitiatedUserId);

        insertFriendRequestStub.withArgs(insertArgs).resolves({ requestId: testRequestId, logId: testLogId });

        const insertionResult = await handler.directRequestManagement(testEvent);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS', requestId: testRequestId }));
    });

     it('Finds target user id by contact detail where absent', async () => {
        const requestedShareItems = ['ACTIVITY_COUNT'];
        const testContactDetails = { contactType: 'EMAIL', contactMethod: 'user@email.com' };
        const insertionArgs = {
            requestedShareItems,
            initiatedUserId: testInitiatedUserId,
            targetUserId: testTargetUserId,
            targetContactDetails: testContactDetails
        };

        const testEvent = helper.wrapEvent({ targetPhoneOrEmail: 'user@email.com', requestedShareItems }, testInitiatedUserId, 'ORDINARY_USER');

        insertFriendRequestStub.resolves({ requestId: testRequestId, logId: testLogId });

        const profileResult = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ systemWideUserId: testTargetUserId })})};
        lamdbaInvokeStub.returns({ promise: () => profileResult });

        const insertionResult = await handler.addFriendshipRequest(testEvent);
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS', requestId: testRequestId }));
        
        const expectedProfileCallBody = { phoneOrEmail: 'user@email.com', countryCode: 'ZAF' };
        const expectedLambdaInvoke = helper.wrapLambdaInvoc('profile_find_by_details', false, expectedProfileCallBody);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly(insertionArgs);
    });

    it('Handles target user id not found, SMS route', async () => {
        const requestedShareItems = ['BALANCE', 'SAVE_VALUES'];
        const testContactDetails = { contactType: 'PHONE', contactMethod: '27632310922' };
        const customShareMessage = 'Hey Jane. Lets save some lettuce, take over the world.';
        const insertionArgs = {
            initiatedUserId: testInitiatedUserId,
            targetContactDetails: testContactDetails,
            requestCode: 'CLIMATE LEG',
            requestedShareItems,
            customShareMessage: '54'
        };
        const sendSmsArgs = {
            phoneNumber: testContactDetails.contactMethod,
            message: customShareMessage
        };

        const testEvent = helper.wrapParamsWithPath({ targetPhoneOrEmail: '27632310922', requestedShareItems, customShareMessage }, 'initiate', testInitiatedUserId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 404 })})});
        
        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(testProfile);
        sendSmsStub.withArgs(sendSmsArgs).resolves({ result: 'SUCCESS' });
        
        fetchActiveCodesStub.withArgs().resolves(['POETRY SHELLS', 'SENSE BANK', 'BEAR CELL']);
        randomWordStub.onFirstCall().returns('BEAR CELL');
        randomWordStub.onSecondCall().returns('CLIMATE LEG');

        const insertionResult = await handler.directRequestManagement(testEvent);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId },
                dispatchResult: { result: 'SUCCESS' }
            }
        }));

        const expectedProfileCallBody = { phoneOrEmail: '27632310922', countryCode: 'ZAF' };
        const expectedLambdaInvoke = helper.wrapLambdaInvoc('profile_find_by_details', false, expectedProfileCallBody);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);
    });

    it('Handles target user id not found, email route', async () => {
        const requestedShareItems = ['BALANCE', 'ACTIVITY_COUNT'];
        const testContactDetails = { contactType: 'EMAIL', contactMethod: 'juitsung@yuan.com' };
        const insertionArgs = {
            initiatedUserId: testInitiatedUserId,
            targetContactDetails: testContactDetails,
            requestCode: 'ORBIT PAGE',
            requestedShareItems,
            customShareMessage: null
        };
        const sendEmailArgs = {
            subject: config.get('templates.email.default.subject'),
            toList: [testContactDetails.contactMethod],
            bodyTemplateKey: config.get('templates.email.default.templateKey'),
            templateVariables: { initiatedUserName: testProfile.calledName }
        };

        const testEvent = helper.wrapParamsWithPath({ targetPhoneOrEmail: 'juitsung@yuan.com', requestedShareItems }, 'initiate', testInitiatedUserId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 404 })})});

        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(testProfile);
        sendEmailStub.withArgs(sendEmailArgs).resolves({ result: 'SUCCESS' });

        fetchActiveCodesStub.withArgs().resolves(['DRY SLABS', 'POETRY BEAN', 'COMPASS MAJOR']);
        randomWordStub.returns('ORBIT PAGE');

        const insertionResult = await handler.directRequestManagement(testEvent);

        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId },
                dispatchResult: { result: 'SUCCESS' }
            }
        }));

        expect(lamdbaInvokeStub).to.have.been.calledOnce;
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly(insertionArgs);
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testInitiatedUserId });
        expect(sendEmailStub).to.have.been.calledOnceWithExactly(sendEmailArgs);
        expect(fetchActiveCodesStub).to.have.been.calledOnceWithExactly();
        expect(randomWordStub).to.have.been.calledOnce;
    });

    it('Throws an error on potential phishing in custom share message', async () => {
        const customShareMessage = 'Hey potential victim. Give me your password. Everything will be fine.';
        const expectedResult = { message: 'Error: Invalid custom share message' };
        const testEvent = helper.wrapParamsWithPath({ targetPhoneOrEmail: '27994593458', customShareMessage }, 'initiate', testInitiatedUserId);
        const phishingResult = await handler.directRequestManagement(testEvent);
        expect(phishingResult).to.exist;
        expect(phishingResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendRequestStub).to.have.not.been.called;
    });


    it('Rejects unauthorized requests', async () => {
        const insertionResult = await handler.addFriendshipRequest({ targetUserId: testTargetUserId });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendRequestStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.not.have.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! targetUserId or targetPhoneOrEmail must be provided' };
        const testEvent = helper.wrapParamsWithPath({ }, 'initiate', testInitiatedUserId);
        const insertionResult = await handler.directRequestManagement(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendRequestStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.not.have.been.called;
    });

});

describe('*** UNIT TEST FRIEND REQUEST EXTRACTION ***', () => {
    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockFriendRequest = {
        requestId: testRequestId,
        creationTime: testCreationTime,
        updatedTime: testUpdatedTime,
        requestStatus: 'PENDING',
        initiatedUserId: testInitiatedUserId,
        targetUserId: testTargetUserId,
        requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
        targetContactDetails: {
            contactType: 'PHONE',
            contactMethod: '27894534503'
        },
        requestType: 'CREATE',
        requestCode: 'DARK SCIENCE'
    };

    const mockProfile = {
        systemWideUserId: testInitiatedUserId,
        personalName: 'Qin Shi',
        familyName: 'Huang',
        phoneNumber: '02130940334',
        calledName: 'Ying Zheng',
        emailAddress: 'yingzheng@qin.com'
    };

    const expectedFriendRequest = { 
        type: 'RECEIVED',
        requestId: testRequestId,
        requestCode: 'DARK SCIENCE',
        requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
        creationTime: testCreationTime,
        personalName: 'Qin Shi',
        familyName: 'Huang',
        calledName: 'Ying Zheng',
        numberOfMutualFriends: 12
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches pending friend requests for user', async () => {
        const testEvent = helper.wrapParamsWithPath({ }, 'list', testTargetUserId);
        fetchAllRequestsStub.withArgs(testTargetUserId).resolves([mockFriendRequest, mockFriendRequest]);
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(mockProfile);
        countMutualFriendsStub.withArgs(testTargetUserId, [testInitiatedUserId]).resolves([{ [testInitiatedUserId]: 12 }]);
        const fetchResult = await handler.directRequestManagement(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([expectedFriendRequest, expectedFriendRequest]));
    });

    it('Rejects unauthorized requests', async () => {
        const fetchResult = await handler.findFriendRequestsForUser({ httpMethod: 'POST', body: JSON.stringify({ }) });
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal({ statusCode: 403 });
        expect(fetchAllRequestsStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const testEvent = helper.wrapEvent({}, testTargetUserId, 'ORDINARY_USER');
        fetchAllRequestsStub.withArgs(testTargetUserId).throws(new Error('Error!'));
        const fetchResult = await handler.findFriendRequestsForUser(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse({ message: 'Error!' }, 500));
    });

});

describe('*** UNIT TEST IGNORE FRIEND REQUEST ***', () => {
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Ignores a friend request properly', async () => {
        const testEvent = helper.wrapParamsWithPath({ initiatedUserId: testInitiatedUserId }, 'ignore', testTargetUserId);

        ignoreRequestStub.withArgs(testTargetUserId, testInitiatedUserId).resolves({ updatedTime: testUpdatedTime, logId: testLogId });

        const resultOfIgnore = await handler.directRequestManagement(testEvent);

        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                resultOfIgnore: {
                    updatedTime: testUpdatedTime,
                    logId: testLogId
                }
            }
        }));
    });

    it('Rejects unauthorized requests', async () => {
        const resultOfIgnore = await handler.ignoreFriendshipRequest({ initiatedUserId: testInitiatedUserId });
        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal({ statusCode: 403 });
        expect(ignoreRequestStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        ignoreRequestStub.withArgs(testTargetUserId, testInitiatedUserId).throws(new Error('Error!'));
        const testEvent = helper.wrapEvent({ initiatedUserId: testInitiatedUserId }, testTargetUserId, 'ORDINARY_USER');
        const resultOfIgnore = await handler.ignoreFriendshipRequest(testEvent);
        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal(helper.wrapResponse({ message: 'Error!' }, 500));
    });

});
