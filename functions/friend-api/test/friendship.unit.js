'use strict';

// const logger = require('debug')('jupiter:friends:test');
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

describe('*** UNIT TEST FRIENDSHIP CREATION ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId });
        insertFriendshipStub.withArgs(testRequestId, testInitiatedUserId, testTargetUserId).resolves({ relationshipId: testRelationshipId, logId: testLogId });

        const insertionResult = await handler.directRequestManagement(helper.wrapParamsWithPath({ requestId: testRequestId }, 'accept', testTargetUserId));
        
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
