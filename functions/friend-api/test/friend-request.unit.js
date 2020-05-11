'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');
const format = require('string-format');

const proxyquire = require('proxyquire').noCallThru();

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const sendSmsStub = sinon.stub();
const sendEmailStub = sinon.stub();
const randomWordStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const ignoreRequestStub = sinon.stub();
const publishUserEventStub = sinon.stub();
const fetchAllRequestsStub = sinon.stub();
const fetchSingleRequestStub = sinon.stub();
const fetchActiveCodesStub = sinon.stub();
const countMutualFriendsStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();

const testLogId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
const testRequestId = uuid();

const testCreationTime = moment().format();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

// eslint-disable-next-line
class MockRedis { constructor() { } }; // forcing no call through

const handler = proxyquire('../friend-handler', {
    './persistence/read.friends': {
        'fetchFriendRequestsForUser': fetchAllRequestsStub,
        'fetchFriendshipRequestById': fetchSingleRequestStub,
        'fetchActiveRequestCodes': fetchActiveCodesStub,
        'countMutualFriends': countMutualFriendsStub,
        'fetchUserProfile': fetchProfileStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        'ignoreFriendshipRequest': ignoreRequestStub,
        'insertFriendRequest': insertFriendRequestStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishUserEventStub,
        'sendSystemEmail': sendEmailStub,
        'sendSms': sendSmsStub,
        '@noCallThru': true
    },
    'ioredis': MockRedis,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'random-words': randomWordStub
});

const resetStubs = () => helper.resetStubs(fetchProfileStub, insertFriendRequestStub, countMutualFriendsStub, publishUserEventStub,
    fetchActiveCodesStub, randomWordStub, sendEmailStub, sendSmsStub, fetchAllRequestsStub, ignoreRequestStub, lamdbaInvokeStub);


describe('*** UNIT TEST FRIEND REQUEST INSERTION ***', () => {

    const testProfile = {
        systemWideUserId: testInitiatedUserId,
        personalName: 'Yao',
        familyName: 'Shu',
        phoneNumber: '02130940334',
        calledName: 'Yao Shu',
        emailAddress: 'yaoshu@orkhon.com',
        referralCode: 'TUNNELS'
    };

    const expectedFriendRequest = (requestedShareItems) => ({
        type: 'INITIATED',
        requestId: testRequestId,
        requestedShareItems,
        creationTime: testCreationTime,
        personalName: 'Yao',
        familyName: 'Shu',
        calledName: 'Yao Shu'
    });

    const mockFriendRequest = ({ targetUserId, targetContactDetails, requestedShareItems }) => {
        const assembledRequest = {
            requestId: testRequestId,
            creationTime: testCreationTime,
            requestedShareItems: requestedShareItems ? requestedShareItems : [],
            initiatedUserId: testInitiatedUserId
        };

        if (targetUserId) {
            assembledRequest.targetUserId = targetUserId;
        }

        if (targetContactDetails) {
            assembledRequest.targetContactDetails = targetContactDetails;
        }

        return assembledRequest;
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friend request', async () => {
        const requestedShareItems = ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'];
        const insertArgs = { initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId, requestedShareItems };
        const testEvent = helper.wrapParamsWithPath({ targetUserId: testTargetUserId, requestedShareItems }, 'initiate', testInitiatedUserId);

        insertFriendRequestStub.withArgs(insertArgs).resolves(mockFriendRequest({ targetUserId: testTargetUserId, requestedShareItems }));
        fetchProfileStub.withArgs({ systemWideUserId: testTargetUserId }).resolves(testProfile);
        publishUserEventStub.resolves({ result: 'SUCCESS' });

        const insertionResult = await handler.directRequestManagement(testEvent);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedFriendRequest(requestedShareItems)));
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testTargetUserId });

        expect(publishUserEventStub).to.have.been.calledTwice;
        expect(publishUserEventStub).to.have.been.calledWithExactly(testInitiatedUserId, 'FRIEND_REQUEST_INITIATED', sinon.match.object);
        expect(publishUserEventStub).to.have.been.calledWithExactly(testTargetUserId, 'FRIEND_REQUEST_RECEIVED', sinon.match.object);
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

        insertFriendRequestStub.resolves(mockFriendRequest({ targetUserId: testTargetUserId, requestedShareItems }));

        const profileResult = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ systemWideUserId: testTargetUserId })})};
        lamdbaInvokeStub.returns({ promise: () => profileResult });

        fetchProfileStub.withArgs({ systemWideUserId: testTargetUserId }).resolves(testProfile);
        publishUserEventStub.resolves({ result: 'SUCCESS' });

        const insertionResult = await handler.addFriendshipRequest(testEvent);
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedFriendRequest(requestedShareItems)));
        
        const expectedProfileCallBody = { phoneOrEmail: 'user@email.com', countryCode: 'ZAF' };
        const expectedLambdaInvoke = helper.wrapLambdaInvoc('profile_find_by_details', false, expectedProfileCallBody);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly(insertionArgs);

        expect(publishUserEventStub).to.have.been.calledTwice;
        expect(publishUserEventStub).to.have.been.calledWithExactly(testInitiatedUserId, 'FRIEND_REQUEST_INITIATED', sinon.match.object);
        expect(publishUserEventStub).to.have.been.calledWithExactly(testTargetUserId, 'FRIEND_REQUEST_RECEIVED', sinon.match.object);
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
            customShareMessage: 'Hey Jane. Lets save some lettuce, take over the world.'
        };


        const downloadLink = config.get('templates.downloadLink');
        const expectedLinkPart = format(config.get('templates.sms.friendRequest.linkPart'), { downloadLink, referralCode: 'TUNNELS' });
        const expectedSms = `${customShareMessage} ${expectedLinkPart}`;
        
        const sendSmsArgs = {
            phoneNumber: testContactDetails.contactMethod,
            message: expectedSms
        };

        const expectedFriendReq = {
            type: 'INITIATED',
            requestId: testRequestId,
            requestedShareItems,
            creationTime: testCreationTime,
            contactMethod: testContactDetails.contactMethod
        };

        const testEvent = helper.wrapParamsWithPath({ targetPhoneOrEmail: '27632310922', requestedShareItems, customShareMessage }, 'initiate', testInitiatedUserId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 404 })})});
        
        insertFriendRequestStub.withArgs(insertionArgs).resolves(mockFriendRequest({ targetContactDetails: testContactDetails, requestedShareItems }));
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(testProfile);
        sendSmsStub.resolves({ result: 'SUCCESS' });
        
        fetchActiveCodesStub.withArgs().resolves(['POETRY SHELLS', 'SENSE BANK', 'BEAR CELL']);
        randomWordStub.onFirstCall().returns('BEAR CELL');
        randomWordStub.onSecondCall().returns('CLIMATE LEG');

        const insertionResult = await handler.directRequestManagement(testEvent);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedFriendReq));

        const expectedProfileCallBody = { phoneOrEmail: '27632310922', countryCode: 'ZAF' };
        const expectedLambdaInvoke = helper.wrapLambdaInvoc('profile_find_by_details', false, expectedProfileCallBody);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);
        
        expect(sendSmsStub).to.have.been.calledOnceWithExactly(sendSmsArgs);
        
        expect(publishUserEventStub).to.have.been.calledOnce;
        expect(publishUserEventStub).to.have.been.calledWithExactly(testInitiatedUserId, 'FRIEND_REQUEST_INITIATED', sinon.match.object);
    });

    it('Handles target user id not found, email route', async () => {
        const requestedShareItems = ['BALANCE', 'ACTIVITY_COUNT'];
        const testContactDetails = { contactType: 'EMAIL', contactMethod: 'juitsung@yuan.com' };
        const customShareMessage = 'Hey Jane.\n\nLets save some lettuce, take over the world.';

        const insertionArgs = {
            initiatedUserId: testInitiatedUserId,
            targetContactDetails: testContactDetails,
            requestCode: 'ORBIT PAGE',
            requestedShareItems,
            customShareMessage: customShareMessage.replace(/\n\s*\n/g, '\n')
        };

        const expectedTemplateVars = {
            initiatedUserName: testProfile.calledName,
            customShareMessage,
            downloadLink: config.get('templates.downloadLink'),
            referralCode: 'TUNNELS'
        };

        const sendEmailArgs = {
            subject: 'Yao Shu wants you to save with them on Jupiter',
            toList: [testContactDetails.contactMethod],
            bodyTemplateKey: config.get('templates.email.default.templateKey'),
            templateVariables: expectedTemplateVars
        };

        const expectedFriendReq = {
            type: 'INITIATED',
            requestId: testRequestId,
            requestedShareItems,
            creationTime: testCreationTime,
            contactMethod: testContactDetails.contactMethod
        };

        const testPayload = { targetPhoneOrEmail: 'juitsung@yuan.com', requestedShareItems, customShareMessage };
        const testEvent = helper.wrapParamsWithPath(testPayload, 'initiate', testInitiatedUserId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 404 })})});

        insertFriendRequestStub.resolves(mockFriendRequest({ targetContactDetails: testContactDetails, requestedShareItems }));
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(testProfile);
        sendEmailStub.withArgs(sendEmailArgs).resolves({ result: 'SUCCESS' });

        fetchActiveCodesStub.withArgs().resolves(['DRY SLABS', 'POETRY BEAN', 'COMPASS MAJOR']);
        randomWordStub.returns('ORBIT PAGE');

        const insertionResult = await handler.directRequestManagement(testEvent);

        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedFriendReq));

        expect(lamdbaInvokeStub).to.have.been.calledOnce;
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly(insertionArgs);
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testInitiatedUserId });
        expect(sendEmailStub).to.have.been.calledOnceWithExactly(sendEmailArgs);
        
        expect(publishUserEventStub).to.have.been.calledOnce;
        expect(publishUserEventStub).to.have.been.calledWithExactly(testInitiatedUserId, 'FRIEND_REQUEST_INITIATED', sinon.match.object);

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
        requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
        creationTime: testCreationTime,
        personalName: 'Qin Shi',
        familyName: 'Huang',
        calledName: 'Ying Zheng',
        numberOfMutualFriends: 12,
        requestCode: 'DARK SCIENCE'
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
        const testEvent = helper.wrapParamsWithPath({ requestId: testRequestId }, 'ignore', testTargetUserId);

        fetchSingleRequestStub.resolves({ targetUserId: testTargetUserId });
        ignoreRequestStub.withArgs(testRequestId, testTargetUserId).resolves({ updatedTime: testUpdatedTime, logId: testLogId });

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

    it('Rejects attempts by other users to call', async () => {
        const testEvent = helper.wrapParamsWithPath({ requestId: testRequestId }, 'ignore', uuid());
        fetchSingleRequestStub.resolves({ targetUserId: testTargetUserId });
        const resultOfIgnore = await handler.directRequestManagement(testEvent);
        expect(resultOfIgnore).to.deep.equal({ statusCode: 403 });
        expect(ignoreRequestStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        fetchSingleRequestStub.withArgs(testRequestId).throws(new Error('Error!'));
        const testEvent = helper.wrapEvent({ requestId: testRequestId }, testTargetUserId, 'ORDINARY_USER');
        const resultOfIgnore = await handler.ignoreFriendshipRequest(testEvent);
        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal(helper.wrapResponse({ message: 'Error!' }, 500));
    });

});
