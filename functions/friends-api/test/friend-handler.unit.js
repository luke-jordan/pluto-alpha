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

const getFriendsStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testSystemId = uuid();
const testIniatedUserId = uuid();
const testTargetUserId = uuid();
const testAcceptedUserId = uuid();
const testRelationshipId = uuid();

const handler = proxyquire('../friend-handler', {
    './persistence/get-profiles': {
        'getFriendIdsForUser': getFriendsStub,
        'fetchUserProfile': fetchProfileStub
    },
    './persistence/handle-profiles': {
        'insertFriendRequest': insertFriendRequestStub,
        'insertFriendship': insertFriendshipStub,
        'deactivateFriendship': deactivateFriendshipStub
    }
});

const resetStubs = () => helper.resetStubs(getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub, deactivateFriendshipStub);

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


describe('*** UNIT TEST ADD FRIEND REQUEST ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friend request', async () => {
        insertFriendRequestStub.withArgs({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId }).resolves({ requestId: uuid() });
        const testEvent = helper.wrapEvent({ targetUserId: testTargetUserId }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });
    });

    it('Rejects unauthorized requests', async () => {
        const insertionResult = await handler.addFriendRequest({ targetUserId: testTargetUserId });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! targetUserId or targetContactDetails must be provided' };
        const testEvent = helper.wrapEvent({ }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST ADD FRIENDSHIP ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        insertFriendshipStub.withArgs(testIniatedUserId, testAcceptedUserId).resolves({ relationshipId: uuid() });
        const testEvent = { initiatedUserId: testIniatedUserId, acceptedUserId: testAcceptedUserId };
        const insertionResult = await handler.addFriendship(helper.wrapEvent(testEvent, testIniatedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendshipStub).to.have.been.calledOnceWithExactly(testIniatedUserId, testAcceptedUserId);
    });

    it('Rejects unauthorized requests', async () => {
        const testEvent = { initiatedUserId: testIniatedUserId, acceptedUserId: testAcceptedUserId };
        const insertionResult = await handler.addFriendship({ httpMethod: 'POST', body: JSON.stringify(testEvent) });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! Missing initiatedUserId or acceptedUserId' };
        const testEvent = { initiatedUserId: testIniatedUserId };
        const insertionResult = await handler.addFriendship(helper.wrapEvent(testEvent, testIniatedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST REMOVE FRIENDSHIP ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        deactivateFriendshipStub.withArgs(testRelationshipId).resolves({ relationshipId: uuid() });
        const testEvent = { relationshipId: testRelationshipId };
        const removalResult = await handler.removeFriendship(helper.wrapEvent(testEvent, testSystemId, 'ORDINARY_USER'));
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(deactivateFriendshipStub).to.have.been.calledOnceWithExactly(testRelationshipId);
    });

    it('Rejects unauthorized requests', async () => {
        const removalResult = await handler.removeFriendship({ relationshipId: testRelationshipId });
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal({ statusCode: 403 });
        expect(deactivateFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const expectedResult = { message: 'Error! Missing relationshipId' };
        const removalResult = await handler.removeFriendship(helper.wrapEvent({ }, testSystemId, 'ORDINARY_USER'));
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(deactivateFriendshipStub).to.have.not.been.called;

    });

});
