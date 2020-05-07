'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const connectUserStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchRequestStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testLogId = uuid();
const testSystemId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
const testAcceptedUserId = uuid();
const testRelationshipId = uuid();
const testRequestId = uuid();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

// eslint-disable-next-line
class MockRedis { constructor() { } }; // forcing no call through

const handler = proxyquire('../friend-handler', {
    './persistence/read.friends': {
        'fetchFriendshipRequestById': fetchRequestStub,
        'fetchUserProfile': fetchProfileStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        'deactivateFriendship': deactivateFriendshipStub,
        'connectUserToFriendRequest': connectUserStub,
        'insertFriendship': insertFriendshipStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'ioredis': MockRedis
});

const resetStubs = () => helper.resetStubs(fetchProfileStub, insertFriendshipStub, deactivateFriendshipStub,
    fetchRequestStub, connectUserStub, lamdbaInvokeStub);


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

describe('*** FRIENDSHIP UTIL FUNCTIONS ***', () => {

    const testProfile = {
        systemWideUserId: testSystemId,
        personalName: 'Nurhaci',
        familyName: 'Gioro',
        phoneNumber: '16349324310',
        calledName: 'Tien-ming',
        emailAddress: 'taizu@manchu.com',
        referralCode: 'LETMEIN',
        countryCode: 'ZAF'
    };

    const testReferralDetails = {
        referralCode: 'LETMEIN',
        context: { boostAmountOffered: 'BIGCHEESE' }
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Determines if a contact method is aligned to a user', async () => {
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.lookupByContactDetails'), false, { phoneOrEmail: 'user@email.com', countryCode: 'ZAF' });
        const testEvent = helper.wrapParamsWithPath({ phoneOrEmail: 'user@email.com' }, 'seek', testSystemId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ systemWideUserId: testSystemId })})})});
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(testProfile);

        const result = await handler.directRequestManagement(testEvent);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal({ systemWideUserId: testSystemId, targetUserName: 'Tien-ming Gioro' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testSystemId });
    });

    it('Obtains referral code', async () => {
        const testReferralPayload = { referralCode: 'LETMEIN', countryCode: 'ZAF', includeFloatDefaults: true };
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.referralDetails'), false, testReferralPayload);
        const testEvent = helper.wrapParamsWithPath({ }, 'referral', testSystemId);

        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(testProfile);
        lamdbaInvokeStub.withArgs(lambdaArgs).returns({ promise: () => (testReferralDetails) });

        const referralCode = await handler.directRequestManagement(testEvent);

        expect(referralCode).to.exist;
        expect(referralCode).to.deep.equal(testReferralDetails);
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testSystemId });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
    });

});
