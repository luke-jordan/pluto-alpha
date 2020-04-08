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

const getFriendsStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();

const handler = proxyquire('../friend-handler', {
    './persistence/get-profiles': {
        'getFriendIdsForUser': getFriendsStub,
        'fetchUserProfile': fetchProfileStub
    },
    './persistence/handle-profiles': {
        'insertFriendRequest': insertFriendRequestStub,
        'insertFriendship': insertFriendshipStub
    }
});

describe('*** UNIT TEST FRIEND HANDLER FUNCTIONS ***', () => {

    const testSystemId = uuid();
    const testIniatedUserId = uuid();
    const testTargetUserId = uuid();
    const testAcceptedUserId = uuid();

    const testProfile = {
        systemWideUserId: testAcceptedUserId,
        creationTimeEpochMillis: moment().valueOf(),
        clientId: 'test_client_id',
        floatId: 'test_float_id',
        defaultCurrency: 'USD',
        defaultTimezone: 'America/New_York',
        personalName: 'Lie',
        familyName: 'Yukou',
        phoneNumber: '17923835934',
        calledName: 'Liezi',
        emailAddress: 'liezi@tao.com',
        countryCode: 'USA',
        nationalId: '213348347230132',
        userStatus: 'CREATED',
        kycStatus: 'CONTACT_VERIFIED',
        securedStatus: 'PASSWORD_SET',
        updatedTimeEpochMillis: moment().valueOf()
    };

    beforeEach(() => {
        helper.resetStubs(getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub);
    });

    it('Fetches profiles for user friends', async () => {
        const requestContext = { requestContext: { authorizer: { systemWideUserId: testSystemId, role: 'ORDINARY_USER' }}};
        getFriendsStub.withArgs(testSystemId).resolves([testAcceptedUserId, testAcceptedUserId, testAcceptedUserId]);
        fetchProfileStub.withArgs({ systemWideUserId: testAcceptedUserId }).resolves(testProfile);
        const fetchResult = await handler.obtainFriends(requestContext);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse({ [testSystemId]: [testProfile, testProfile, testProfile] }));
    });

    it('Persists new friend request', async () => {
        insertFriendRequestStub.withArgs({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId }).resolves({ requestId: uuid() });
        const testEvent = helper.wrapEvent({ targetUserId: testTargetUserId }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });
    });

    it('Persists new friendship', async () => {
        insertFriendshipStub.withArgs(testIniatedUserId, testAcceptedUserId).resolves({ relationshipId: uuid() });
        const testEvent = { initiatedUserId: testIniatedUserId, acceptedUserId: testAcceptedUserId };
        const insertionResult = await handler.addFriendship(helper.wrapEvent(testEvent, testIniatedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({ result: 'SUCCESS' }));
        expect(insertFriendshipStub).to.have.been.calledOnceWithExactly(testIniatedUserId, testAcceptedUserId);
    });

});
