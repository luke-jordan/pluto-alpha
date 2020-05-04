'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');
const format = require('string-format');

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
const fetchUserStub = sinon.stub();
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
const insertFriendRequestStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testLogId = uuid();
const testSystemId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
const testAcceptedUserId = uuid();
const testRelationshipId = uuid();
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
        'fetchUserByContactDetail': fetchUserStub,
        'fetchActiveRequestCodes': fetchActiveCodesStub,
        'fetchFriendshipRequestById': fetchRequestStub,
        'fetchAccountIdForUser': fetchAccountStub,
        'getFriendIdsForUser': getFriendsStub,
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

const resetStubs = () => helper.resetStubs(fetchUserStub, getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub,
    deactivateFriendshipStub, fetchActiveCodesStub, fetchRequestStub, randomWordStub, sendEmailStub, sendSmsStub, connectUserStub,
    fetchAllRequestsStub, ignoreRequestStub, fetchAccountStub, lamdbaInvokeStub, redisGetStub);

describe('*** UNIT TEST FRIEND PROFILE EXTRACTION ***', () => {

    const mockProfile = (systemWideUserId) => ({
        systemWideUserId,
        personalName: 'Lie',
        familyName: 'Yukou',
        phoneNumber: '17923835934',
        calledName: 'Liezi',
        emailAddress: 'liezi@tao.com'
    });

    const expectedSavingsHeat = 23.71;
    const expectedProfile = (userId) => ({ ...mockProfile(userId), savingsHeat: expectedSavingsHeat });

    beforeEach(() => {
        resetStubs();
    });

    it('Returns empty if user has no friends yet', async () => {
        getFriendsStub.resolves([]);
        const fetchResult = await handler.obtainFriends(helper.wrapEvent({}, testSystemId));
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([]));
    });

    it('Fetches user friends', async () => {
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const [firstAccId, secondAccId, thirdAccId] = [uuid(), uuid(), uuid()];
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.calcSavingsHeat'), false, { accountIds: [secondAccId, thirdAccId] });
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');

        getFriendsStub.withArgs(testSystemId).resolves([firstUserId, secondUserId, thirdUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        lamdbaInvokeStub.withArgs(lambdaArgs).returns({
            promise: () => helper.mockLambdaResponse([
                { accountId: secondAccId, savingsHeat: `${expectedSavingsHeat}` },
                { accountId: thirdAccId, savingsHeat: `${expectedSavingsHeat}` }
            ])
        });
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify({ accountId: firstAccId, savingsHeat: `${expectedSavingsHeat}` }),
            null,
            null
        ]);

        const fetchResult = await handler.obtainFriends(testEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            expectedProfile(firstUserId),
            expectedProfile(secondUserId),
            expectedProfile(thirdUserId)
        ]));
    });

    it('Fetches admin friends too', async () => {
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const [firstAccId, secondAccId, thirdAccId] = [uuid(), uuid(), uuid()];
        const testEvent = helper.wrapEvent({}, testSystemId, 'SYSTEM_ADMIN');
       
        getFriendsStub.withArgs(testSystemId).resolves([firstUserId, secondUserId, thirdUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify({ accountId: firstAccId, savingsHeat: `${expectedSavingsHeat}` }),
            JSON.stringify({ accountId: secondAccId, savingsHeat: `${expectedSavingsHeat}` }),
            JSON.stringify({ accountId: thirdAccId, savingsHeat: `${expectedSavingsHeat}` })
        ]);

        const fetchResult = await handler.obtainFriends(testEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            expectedProfile(firstUserId),
            expectedProfile(secondUserId),
            expectedProfile(thirdUserId)
        ]));
    });

    it('Fetches friends for admin provided user', async () => {
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const [firstAccId, secondAccId, thirdAccId] = [uuid(), uuid(), uuid()];
        const testEvent = helper.wrapEvent({ systemWideUserId: testInitiatedUserId }, testSystemId, 'SYSTEM_ADMIN');

        getFriendsStub.withArgs(testInitiatedUserId).resolves([firstUserId, secondUserId, thirdUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify({ accountId: firstAccId, savingsHeat: `${expectedSavingsHeat}` }),
            JSON.stringify({ accountId: secondAccId, savingsHeat: `${expectedSavingsHeat}` }),
            JSON.stringify({ accountId: thirdAccId, savingsHeat: `${expectedSavingsHeat}` })
        ]);
        const fetchResult = await handler.obtainFriends(testEvent);
        
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            expectedProfile(firstUserId),
            expectedProfile(secondUserId),
            expectedProfile(thirdUserId)
        ]));
    });

    it('Rejects unauthorized requests', async () => {
        const fetchResult = await handler.obtainFriends({ systemWideUserId: testInitiatedUserId });
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal({ statusCode: 403 });
        expect(getFriendsStub).to.have.not.been.called;
        expect(fetchProfileStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getFriendsStub.withArgs(testSystemId).throws(new Error('Error'));
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');
        const fetchResult = await handler.obtainFriends(testEvent);
        expect(fetchResult).to.deep.equal(helper.wrapResponse({ message: 'Error' }, 500));
        expect(fetchProfileStub).to.have.not.been.called;
    });

});

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
        const testEvent = helper.wrapEvent({ targetUserId: testTargetUserId, requestedShareItems }, testInitiatedUserId, 'ORDINARY_USER');

        insertFriendRequestStub.withArgs(insertArgs).resolves({ requestId: testRequestId, logId: testLogId });

        const insertionResult = await handler.addFriendshipRequest(testEvent);

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

        const testEvent = helper.wrapEvent({ targetContactDetails: 'user@email.com', requestedShareItems }, testInitiatedUserId, 'ORDINARY_USER');

        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchUserStub.withArgs(testContactDetails).resolves({ systemWideUserId: testTargetUserId });

        const insertionResult = await handler.addFriendshipRequest(testEvent);
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS', requestId: testRequestId }));
    });

    it('Handles target user id not found, SMS route', async () => {
        const requestedShareItems = ['BALANCE', 'SAVE_VALUES'];
        const testContactDetails = { contactType: 'PHONE', contactMethod: '27632310922' };
        const insertionArgs = {
            initiatedUserId: testInitiatedUserId,
            targetContactDetails: testContactDetails,
            requestCode: 'CLIMATE LEG',
            requestedShareItems
        };
        const sendSmsArgs = {
            phoneNumber: testContactDetails.contactMethod,
            message: format(config.get('sms.friendRequest.template'), testProfile.calledName)
        };

        const testEvent = helper.wrapEvent({ targetContactDetails: '27632310922', requestedShareItems }, testInitiatedUserId, 'ORDINARY_USER');

        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(testProfile);
        sendSmsStub.withArgs(sendSmsArgs).resolves({ result: 'SUCCESS' });
        fetchUserStub.withArgs(testContactDetails).resolves();
        fetchActiveCodesStub.withArgs().resolves(['POETRY SHELLS', 'SENSE BANK', 'BEAR CELL']);
        randomWordStub.onFirstCall().returns('BEAR CELL');
        randomWordStub.onSecondCall().returns('CLIMATE LEG');

        const insertionResult = await handler.addFriendshipRequest(testEvent);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId },
                dispatchResult: { result: 'SUCCESS' }
            }
        }));
    });

    it('Handles target user id not found, email route', async () => {
        const requestedShareItems = ['BALANCE', 'ACTIVITY_COUNT'];
        const testContactDetails = { contactType: 'EMAIL', contactMethod: 'juitsung@yuan.com' };
        const insertionArgs = {
            initiatedUserId: testInitiatedUserId,
            targetContactDetails: testContactDetails,
            requestCode: 'ORBIT PAGE',
            requestedShareItems
        };
        const sendEmailArgs = {
            subject: config.get('email.friendRequest.subject'),
            toList: [testContactDetails.contactMethod],
            bodyTemplateKey: config.get('email.friendRequest.templateKey'),
            templateVariables: { initiatedUserName: testProfile.calledName }
        };

        const testEvent = helper.wrapEvent({ targetContactDetails: 'juitsung@yuan.com', requestedShareItems }, testInitiatedUserId, 'ORDINARY_USER');

        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(testProfile);
        sendEmailStub.withArgs(sendEmailArgs).resolves({ result: 'SUCCESS' });
        fetchUserStub.withArgs(testContactDetails).resolves();
        fetchActiveCodesStub.withArgs().resolves(['DRY SLABS', 'POETRY BEAN', 'COMPASS MAJOR']);
        randomWordStub.returns('ORBIT PAGE');

        const insertionResult = await handler.addFriendshipRequest(testEvent);

        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId },
                dispatchResult: { result: 'SUCCESS' }
            }
        }));
    });

    it('Rejects unauthorized requests', async () => {
        const insertionResult = await handler.addFriendshipRequest({ targetUserId: testTargetUserId });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! targetUserId or targetContactDetails must be provided' };
        const testEvent = helper.wrapEvent({ }, testInitiatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST TARGET USER CONNECTION ***', async () => {
    const testRequestCode = 'BEAR CELL';
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Connects target user to friend request', async () => {
        const testEvent = helper.wrapEvent({ requestCode: testRequestCode }, testTargetUserId, 'ORDINARY_USER');

        connectUserStub.withArgs(testTargetUserId, testRequestCode).resolves([{ requestId: testRequestId, updatedTime: testUpdatedTime }]);

        const connectionResult = await handler.connectFriendshipRequest(testEvent);

        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                updateResult: [{
                    requestId: testRequestId,
                    updatedTime: testUpdatedTime
                }]
            }
        }));
    });

    it('Rejects unauthorized requests', async () => {
        const connectionResult = await handler.addFriendshipRequest({ requestCode: testRequestCode });
        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal({ statusCode: 403 });
        expect(connectUserStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const expectedResult = { message: `Error! No friend request found for request code: ${testRequestCode}` };
        connectUserStub.withArgs(testTargetUserId, testRequestCode).resolves([]);
        const testEvent = helper.wrapEvent({ requestCode: testRequestCode }, testTargetUserId, 'ORDINARY_USER');
        const connectionResult = await handler.connectFriendshipRequest(testEvent);
        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
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

    const expectedFriendRequest = { ...mockFriendRequest, initiatedUserName: 'Ying Zheng' };

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches pending friend requests for user', async () => {
        const testEvent = helper.wrapEvent({ }, testTargetUserId, 'ORDINARY_USER');
        fetchAllRequestsStub.withArgs(testTargetUserId).resolves([mockFriendRequest, mockFriendRequest]);
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(mockProfile);
        const fetchResult = await handler.findFriendRequestsForUser(testEvent);
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
        const testEvent = helper.wrapEvent({ initiatedUserId: testInitiatedUserId }, testTargetUserId, 'ORDINARY_USER');

        ignoreRequestStub.withArgs(testTargetUserId, testInitiatedUserId).resolves({ updatedTime: testUpdatedTime, logId: testLogId });

        const resultOfIgnore = await handler.ignoreFriendshipRequest(testEvent);

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

describe('*** UNIT TEST FRIEND REQUEST ACCEPTANCE ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId });
        insertFriendshipStub.withArgs(testRequestId, testInitiatedUserId, testTargetUserId).resolves({ relationshipId: testRelationshipId, logId: testLogId });

        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testTargetUserId, 'ORDINARY_USER'));
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: {
                    relationshipId: testRelationshipId,
                    logId: testLogId
                }
            }
        }));
    });

    it('Fails where accepting user is not target user', async () => {
        const expectedResult = { message: 'Error! Accepting user is not friendship target' };
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId });
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testAcceptedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid request id', async () => {
        const expectedResult = { message: `Error! No friend request found for request id: ${testRequestId}` };
        fetchRequestStub.withArgs(testRequestId).resolves();
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testAcceptedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Rejects unauthorized requests', async () => {
        const testEvent = { initiatedUserId: testInitiatedUserId, acceptedUserId: testAcceptedUserId };
        const insertionResult = await handler.acceptFriendshipRequest({ httpMethod: 'POST', body: JSON.stringify(testEvent) });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! Missing requestId' };
        const testEvent = { initiatedUserId: testInitiatedUserId };
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent(testEvent, testInitiatedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST FRIENDSHIP REMOVAL ***', () => {
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Deactivates friendship', async () => {
        const testEvent = { relationshipId: testRelationshipId };

        deactivateFriendshipStub.withArgs(testRelationshipId).resolves({ updatedTime: testUpdatedTime, logId: testLogId });

        const removalResult = await handler.deactivateFriendship(helper.wrapEvent(testEvent, testSystemId, 'ORDINARY_USER'));

        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                deactivationResult: {
                    updatedTime: testUpdatedTime,
                    logId: testLogId
                }
            }
        }));
    });

    it('Rejects unauthorized requests', async () => {
        const removalResult = await handler.deactivateFriendship({ relationshipId: testRelationshipId });
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal({ statusCode: 403 });
        expect(deactivateFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! Missing relationshipId' };
        const removalResult = await handler.deactivateFriendship(helper.wrapEvent({ }, testSystemId, 'ORDINARY_USER'));
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(deactivateFriendshipStub).to.have.not.been.called;
    });

});
