'use strict';

// const logger = require('debug')('jupiter:friends:test');
const uuid = require('uuid/v4');

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const fetchUserStub = sinon.stub();
const getFriendsStub = sinon.stub();
const fetchRequestStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testSystemId = uuid();
const testIniatedUserId = uuid();
const testTargetUserId = uuid();
const testAcceptedUserId = uuid();
const testRelationshipId = uuid();
const testRequestId = uuid();

const handler = proxyquire('../friend-handler', {
    './persistence/read.friends': {
        'fetchUserByContactDetail': fetchUserStub,
        'fetchFriendshipRequest': fetchRequestStub,
        'getFriendIdsForUser': getFriendsStub,
        'fetchUserProfile': fetchProfileStub
    },
    './persistence/write.friends': {
        'insertFriendRequest': insertFriendRequestStub,
        'insertFriendship': insertFriendshipStub,
        'deactivateFriendship': deactivateFriendshipStub
    }
});

const resetStubs = () => helper.resetStubs(fetchUserStub, getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub, deactivateFriendshipStub);

describe('*** UNIT TEST FRIEND PROFILE EXTRACTION ***', () => {

    const testProfile = {
        systemWideUserId: testAcceptedUserId,
        personalName: 'Lie',
        familyName: 'Yukou',
        phoneNumber: '17923835934',
        calledName: 'Liezi',
        emailAddress: 'liezi@tao.com'
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches user friends', async () => {
        getFriendsStub.withArgs(testSystemId).resolves([testAcceptedUserId, testAcceptedUserId, testAcceptedUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: testAcceptedUserId }).resolves(testProfile);
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');
        const fetchResult = await handler.obtainFriends(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([testProfile, testProfile, testProfile]));
    });

    it('Fetches admin friends too', async () => {
        getFriendsStub.withArgs(testSystemId).resolves([testAcceptedUserId, testAcceptedUserId, testAcceptedUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: testAcceptedUserId }).resolves(testProfile);
        const testEvent = helper.wrapEvent({}, testSystemId, 'SYSTEM_ADMIN');
        const fetchResult = await handler.obtainFriends(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([testProfile, testProfile, testProfile]));
    });

    it('Fetches friends for admin provided user', async () => {
        getFriendsStub.withArgs(testIniatedUserId).resolves([testAcceptedUserId, testAcceptedUserId, testAcceptedUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: testAcceptedUserId }).resolves(testProfile);
        const testEvent = helper.wrapEvent({ systemWideUserId: testIniatedUserId }, testSystemId, 'SYSTEM_ADMIN');
        const fetchResult = await handler.obtainFriends(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([testProfile, testProfile, testProfile]));
    });

    it('Rejects unauthorized requests', async () => {
        const fetchResult = await handler.obtainFriends({ systemWideUserId: testIniatedUserId });
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
    const testContactDetail = 'user@email.com';

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friend request', async () => {
        insertFriendRequestStub.withArgs({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId }).resolves({ requestId: uuid() });
        const testEvent = helper.wrapEvent({ targetUserId: testTargetUserId }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });
    });

    it('Finds target user id where absent and contact detail is provided', async () => {
        const insertionArgs = { initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId, targetContactDetails: testContactDetail };
        fetchUserStub.withArgs(testContactDetail).resolves({ systemWideUserId: testTargetUserId });
        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: uuid() });

        const testEvent = helper.wrapEvent({ targetContactDetails: testContactDetail }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly(insertionArgs);
    });

    it('Rejects unauthorized requests', async () => {
        const insertionResult = await handler.addFriendshipRequest({ targetUserId: testTargetUserId });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! targetUserId or targetContactDetails must be provided' };
        const testEvent = helper.wrapEvent({ }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST FRIENDSHIP INSERTION ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });
        insertFriendshipStub.withArgs(testIniatedUserId, testTargetUserId).resolves({ relationshipId: uuid() });
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testTargetUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendshipStub).to.have.been.calledOnceWithExactly(testIniatedUserId, testTargetUserId);
    });

    it('Fails where accepting user is not target user', async () => {
        const expectedResult = { message: 'Accepting user is not friendship target' };
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testAcceptedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid request id', async () => {
        const expectedResult = { message: `No friend request found for request id: ${testRequestId}` };
        fetchRequestStub.withArgs(testRequestId).resolves();
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testAcceptedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Rejects unauthorized requests', async () => {
        const testEvent = { initiatedUserId: testIniatedUserId, acceptedUserId: testAcceptedUserId };
        const insertionResult = await handler.acceptFriendshipRequest({ httpMethod: 'POST', body: JSON.stringify(testEvent) });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! Missing requestId' };
        const testEvent = { initiatedUserId: testIniatedUserId };
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent(testEvent, testIniatedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST FRIENDSHIP REMOVAL ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        deactivateFriendshipStub.withArgs(testRelationshipId).resolves({ relationshipId: uuid() });
        const testEvent = { relationshipId: testRelationshipId };
        const removalResult = await handler.deactivateFriendship(helper.wrapEvent(testEvent, testSystemId, 'ORDINARY_USER'));
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(deactivateFriendshipStub).to.have.been.calledOnceWithExactly(testRelationshipId);
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
