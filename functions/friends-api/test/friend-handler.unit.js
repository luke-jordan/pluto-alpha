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
const sendEmailStub = sinon.stub();
const fetchUserStub = sinon.stub();
const getFriendsStub = sinon.stub();
const randomWordStub = sinon.stub();
const connectUserStub = sinon.stub();
const fetchRequestStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const fetchActiveCodesStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testLogId = uuid();
const testSystemId = uuid();
const testIniatedUserId = uuid();
const testTargetUserId = uuid();
const testAcceptedUserId = uuid();
const testRelationshipId = uuid();
const testRequestId = uuid();

const handler = proxyquire('../friend-handler', {
    './persistence/read.friends': {
        'fetchUserByContactDetail': fetchUserStub,
        'fetchActiveRequestCodes': fetchActiveCodesStub,
        'fetchFriendshipRequestById': fetchRequestStub,
        'getFriendIdsForUser': getFriendsStub,
        'fetchUserProfile': fetchProfileStub
    },
    './persistence/write.friends': {
        'connectUserToFriendRequest': connectUserStub,
        'insertFriendRequest': insertFriendRequestStub,
        'insertFriendship': insertFriendshipStub,
        'deactivateFriendship': deactivateFriendshipStub
    },
    'publish-common': {
        'sendSystemEmail': sendEmailStub,
        'sendSms': sendSmsStub,
        '@noCallThru': true
    },
    'random-words': randomWordStub
});

const resetStubs = () => helper.resetStubs(fetchUserStub, getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub,
    deactivateFriendshipStub, fetchActiveCodesStub, fetchRequestStub, randomWordStub, sendEmailStub, sendSmsStub, connectUserStub);

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

    const testProfile = {
        systemWideUserId: testIniatedUserId,
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
        const insertArgs = { initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId };
        insertFriendRequestStub.withArgs(insertArgs).resolves({ requestId: testRequestId, logId: testLogId });

        const testEvent = helper.wrapEvent({ targetUserId: testTargetUserId }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId }
            }
        }));
    });

    it('Finds target user id where absent and contact detail is provided', async () => {
        const testContactDetail = 'user@email.com';
        const insertionArgs = { initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId, targetContactDetails: testContactDetail };
        fetchUserStub.withArgs(testContactDetail).resolves({ systemWideUserId: testTargetUserId });
        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });

        const testEvent = helper.wrapEvent({ targetContactDetails: testContactDetail }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId }
            }
        }));
    });

    it('Handles target user id not found, SMS route', async () => {
        const testContactDetail = '27632310922';
        const insertionArgs = { initiatedUserId: testIniatedUserId, targetContactDetails: testContactDetail, requestCode: 'CLIMATE LEG' };
        const sendSmsArgs = {
            phoneNumber: testContactDetail,
            message: format(config.get('sms.friendRequest.template'), testProfile.calledName)
        };

        fetchUserStub.withArgs(testContactDetail).resolves();
        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchProfileStub.withArgs({ systemWideUserId: testIniatedUserId }).resolves(testProfile);
        sendSmsStub.withArgs(sendSmsArgs).resolves({ result: 'SUCCESS' });
        fetchActiveCodesStub.withArgs().resolves(['POETRY SHELLS', 'SENSE BANK', 'BEAR CELL']);
        randomWordStub.onFirstCall().returns('BEAR CELL');
        randomWordStub.onSecondCall().returns('CLIMATE LEG');

        const testEvent = helper.wrapEvent({ targetContactDetails: testContactDetail }, testIniatedUserId, 'ORDINARY_USER');
        const insertionResult = await handler.addFriendshipRequest(testEvent);
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { requestId: testRequestId, logId: testLogId },
                dispatchResult: { result: 'SUCCESS' }
            }
        }));
    });

    it('Handles target user id not found, email route', async () => {
        const testContactDetail = 'juitsung@yuan.com';
        const insertionArgs = { initiatedUserId: testIniatedUserId, targetContactDetails: testContactDetail, requestCode: 'ORBIT PAGE' };
        const sendEmailArgs = {
            subject: config.get('email.friendRequest.subject'),
            toList: [testContactDetail],
            bodyTemplateKey: config.get('email.friendRequest.templateKey'),
            templateVariables: { initiatedUserName: testProfile.calledName }
        };

        fetchUserStub.withArgs(testContactDetail).resolves();
        insertFriendRequestStub.withArgs(insertionArgs).resolves({ requestId: testRequestId, logId: testLogId });
        fetchProfileStub.withArgs({ systemWideUserId: testIniatedUserId }).resolves(testProfile);
        sendEmailStub.withArgs(sendEmailArgs).resolves({ result: 'SUCCESS' });
        fetchActiveCodesStub.withArgs().resolves(['DRY SLABS', 'POETRY BEAN', 'COMPASS MAJOR']);
        randomWordStub.returns('ORBIT PAGE');

        const testEvent = helper.wrapEvent({ targetContactDetails: testContactDetail }, testIniatedUserId, 'ORDINARY_USER');
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
        const testEvent = helper.wrapEvent({ }, testIniatedUserId, 'ORDINARY_USER');
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
        connectUserStub.withArgs(testTargetUserId, testRequestCode).resolves([{ requestId: testRequestId, updatedTime: testUpdatedTime }]);
        const testEvent = helper.wrapEvent({ requestCode: testRequestCode }, testTargetUserId, 'ORDINARY_USER');

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

describe('*** UNIT TEST FRIENDSHIP INSERTION ***', () => {

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });
        insertFriendshipStub.withArgs(testRequestId, testIniatedUserId, testTargetUserId).resolves({ relationshipId: testRelationshipId, logId: testLogId });
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testTargetUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                insertionResult: { relationshipId: testRelationshipId, logId: testLogId }
            }
        }));
    });

    it('Fails where accepting user is not target user', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId });

        const expectedResult = { message: 'Error! Accepting user is not friendship target' };
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testAcceptedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedResult, 500));
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid request id', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves();

        const expectedResult = { message: `Error! No friend request found for request id: ${testRequestId}` };
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
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Deactivates friendship', async () => {
        deactivateFriendshipStub.withArgs(testRelationshipId).resolves({ updatedTime: testUpdatedTime });

        const testEvent = { relationshipId: testRelationshipId };
        const removalResult = await handler.deactivateFriendship(helper.wrapEvent(testEvent, testSystemId, 'ORDINARY_USER'));
        expect(removalResult).to.exist;
        expect(removalResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                deactivationResult: { updatedTime: testUpdatedTime }
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
