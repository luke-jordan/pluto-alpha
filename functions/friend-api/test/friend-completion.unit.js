
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

const redisGetStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchAccountStub = sinon.stub();
const fetchRequestStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const fecthSavingHeatStub = sinon.stub();
const findPossibleRequestStub = sinon.stub();

const publishUserEventStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const connectTargetViaIdStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();
const countMutualFriendsStub = sinon.stub();

const testAccountId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
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

const handler = proxyquire('../friend-request-handler', {
    './persistence/read.friends': {
        'fetchFriendshipRequestById': fetchRequestStub,
        'countMutualFriends': countMutualFriendsStub,
        'fetchAccountIdForUser': fetchAccountStub,
        'fetchUserProfile': fetchProfileStub,
        'fetchSavingHeatFromCache': fecthSavingHeatStub,
        'findPossibleFriendRequest': findPossibleRequestStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        'insertFriendship': insertFriendshipStub,
        'connectTargetViaId': connectTargetViaIdStub,
        'insertFriendRequest': insertFriendRequestStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishUserEventStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'ioredis': MockRedis
});

const resetStubs = () => helper.resetStubs(fetchProfileStub, insertFriendshipStub, findPossibleRequestStub,
    fetchRequestStub, lamdbaInvokeStub, publishUserEventStub, connectTargetViaIdStub, insertFriendRequestStub);

describe('*** UNIT TEST FRIENDSHIP CREATION ***', () => {
    const testCreationTime = moment().format();
    const testActivityDate = moment().format();

    const expectedsavingHeat = 41.12;

    const mockResponseFromCache = {
        savingHeat: `${expectedsavingHeat}`,
        recentActivity: {
            WITHDRAWAL: {
                creationTime: testActivityDate,
                amount: '100', 
                currency: 'ZAR', 
                unit: 'HUNDREDTH_CENT'
            }
        }
    };

    const testInitiatedProfile = {
        systemWideUserId: testInitiatedUserId,
        personalName: 'Yao',
        familyName: 'Shu',
        phoneNumber: '02130940334',
        calledName: 'Yao Shu',
        emailAddress: 'yaoshu@orkhon.com',
        userStatus: 'USER_HAS_SAVED'
    };

    const testTargetProfile = {
        systemWideUserId: testTargetUserId,
        userStatus: 'USER_HAS_SAVED'
    };

    const expectedFriendship = {
        relationshipId: testRelationshipId,
        personalName: 'Yao',
        familyName: 'Shu',
        calledName: 'Yao Shu',
        contactMethod: '02130940334',
        savingHeat: `${expectedsavingHeat}`,
        shareItems: ['LAST_ACTIVITY']
    };

    const testFriendRequest = {
        requestId: testRequestId,
        initiatedUserId: testInitiatedUserId,
        targetUserId: testTargetUserId,
        requestedShareItems: ['LAST_ACTIVITY'],
        creationTime: testCreationTime
    };

    const mockFriendship = {
        relationshipId: testRelationshipId,
        initiatedUserId: testInitiatedUserId,
        acceptedUserId: testTargetUserId,
        relationshipStatus: 'ACTIVE',
        shareItems: ['LAST_ACTIVITY']
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves(testFriendRequest);
        
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId, forceCacheReset: true}).resolves(testInitiatedProfile);
        fetchProfileStub.withArgs({ systemWideUserId: testTargetUserId, forceCacheReset: true}).resolves(testTargetProfile);
        
        insertFriendshipStub.withArgs(testRequestId, testInitiatedUserId, testTargetUserId).resolves(mockFriendship);
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        
        countMutualFriendsStub.resolves([{ [testInitiatedUserId]: 23 }]);
        fetchAccountStub.resolves({ [testInitiatedUserId]: testAccountId });
        // fecthSavingHeatStub.resolves([JSON.stringify(mockResponseFromCache)]);
        fecthSavingHeatStub.resolves([mockResponseFromCache]);

        const insertionResult = await handler.directRequestManagement(helper.wrapParamsWithPath({ requestId: testRequestId }, 'accept', testTargetUserId));
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedFriendship));
    });

    it('Fails where accepting user is not target user', async () => {
        const wrongUserId = uuid();
        fetchRequestStub.withArgs(testRequestId).resolves({ initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId });
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, wrongUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 400, body: 'Error! Accepting user is not friendship target' });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid request id', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves();
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testTargetUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 404, body: 'Error! No request found for that ID' });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails where either user has not finished a save yet', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves(testFriendRequest);
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId, forceCacheReset: true }).resolves(testInitiatedProfile);
        fetchProfileStub.withArgs({ systemWideUserId: testTargetUserId, forceCacheReset: true }).
            resolves({ systemWideUserId: testTargetUserId, userStatus: 'ACCOUNT_OPENED' });
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent({ requestId: testRequestId }, testTargetUserId));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 400, body: 'Error! One or both users has not finished their first save yet' });
        expect(insertFriendshipStub).to.not.have.been.called;
        expect(publishUserEventStub).to.not.have.been.called;
    });

    it('Rejects unauthorized requests', async () => {
        const testEvent = { initiatedUserId: testInitiatedUserId, acceptedUserId: testTargetUserId };
        const insertionResult = await handler.acceptFriendshipRequest({ httpMethod: 'POST', body: JSON.stringify(testEvent) });
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 403 });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

    it('Fails on invalid parameters', async () => {
        const testEvent = { initiatedUserId: testInitiatedUserId };
        const insertionResult = await handler.acceptFriendshipRequest(helper.wrapEvent(testEvent, testInitiatedUserId, 'ORDINARY_USER'));
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ statusCode: 400, body: 'Error! Missing requestId' });
        expect(insertFriendshipStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST FRIENDSHIPS FROM REFERRAL CODE ***', () => {
    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const testCountryCode = 'ZAF';
    const testReferralCode = 'LETMEIN';
    const testUserEmail = 'user@email.com';

    const testReferralDetails = {
        codeType: 'USER',
        referralCode: 'LETMEIN',
        creatingUserId: testInitiatedUserId,
        context: { boostAmountOffered: 'BIGCHEESE' }
    };

    const friendReqToPersistence = {
        initiatedUserId: testInitiatedUserId,
        targetUserId: testTargetUserId,
        requestType: 'CREATE',
        requestedShareItems: ['SHARE_ACTIVITY'],
        targetContactDetails: {
            contactType: 'EMAIL',
            contactMethod: testUserEmail
        }
    };

    const friendReqFromPersistence = {
        requestId: testRequestId,
        requestType: 'CREATE',
        initiatedUserId: testInitiatedUserId,
        targetUserId: testTargetUserId,
        requestedShareItems: ['LAST_ACTIVITY'],
        targetContactDetails: { contactType: 'EMAIL', contactMethod: testUserEmail },
        creationTime: testCreationTime
    };

    const referralPayload = { referralCode: testReferralCode, countryCode: testCountryCode, includeCreatingUserId: true };
    const referralInvocation = helper.wrapLambdaInvoc(config.get('lambdas.referralDetails'), false, referralPayload);
    
    beforeEach(() => {
        resetStubs();
    });

    it('Initializes a friendship from referral code', async () => {
        const testEvent = {
            targetUserId: testTargetUserId,
            referralCodeUsed: testReferralCode,
            countryCode: testCountryCode,
            emailAddress: testUserEmail
        };

        const referralResult = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ result: 'SUCCESS', codeDetails: testReferralDetails })})};
        lamdbaInvokeStub.returns({ promise: () => referralResult });
        findPossibleRequestStub.resolves(null);
        insertFriendRequestStub.resolves(friendReqFromPersistence);

        const initializationResult = await handler.initiateRequestFromReferralCode(testEvent);

        expect(initializationResult).to.exist;
        expect(initializationResult).to.deep.equal({ result: 'CREATED' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(referralInvocation);
        expect(findPossibleRequestStub).to.have.been.calledOnceWithExactly(testInitiatedUserId, testUserEmail);
        expect(insertFriendRequestStub).to.have.been.calledOnceWithExactly(friendReqToPersistence);
    });

    it('Accepts pending friend request if found', async () => {
        const testEvent = {
            targetUserId: testTargetUserId,
            referralCodeUsed: testReferralCode,
            countryCode: testCountryCode,
            emailAddress: testUserEmail
        };

        const referralResult = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ result: 'SUCCESS', codeDetails: testReferralDetails })})};
        lamdbaInvokeStub.returns({ promise: () => referralResult });
        findPossibleRequestStub.resolves(friendReqFromPersistence);
        connectTargetViaIdStub.resolves({ updatedTime: testUpdatedTime });

        const initializationResult = await handler.initiateRequestFromReferralCode(testEvent);

        expect(initializationResult).to.exist;
        expect(initializationResult).to.deep.equal({ result: 'CONNECTED' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(referralInvocation);
        expect(findPossibleRequestStub).to.have.been.calledOnceWithExactly(testInitiatedUserId, testUserEmail);
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

    it('It fails if user tries to friend themselves', async () => {
        const referralDetails = { ...testReferralDetails };
        referralDetails.creatingUserId = testTargetUserId;

        const testEvent = {
            targetUserId: testTargetUserId,
            referralCodeUsed: testReferralCode,
            countryCode: testCountryCode,
            emailAddress: testUserEmail
        };

        const referralResult = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ result: 'SUCCESS', codeDetails: referralDetails })})};
        lamdbaInvokeStub.returns({ promise: () => referralResult });

        const initializationResult = await handler.initiateRequestFromReferralCode(testEvent);

        expect(initializationResult).to.exist;
        expect(initializationResult).to.deep.equal({ result: 'FAILURE' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(referralInvocation);
        expect(findPossibleRequestStub).to.have.not.been.called;
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

    it('Fails where referral code not found', async () => {
        const testEvent = {
            targetUserId: testTargetUserId,
            referralCodeUsed: testReferralCode,
            countryCode: testCountryCode,
            emailAddress: testUserEmail
        };

        const referralResult = { Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ result: 'CODE_NOT_FOUND' })})};
        lamdbaInvokeStub.returns({ promise: () => referralResult });

        const initializationResult = await handler.initiateRequestFromReferralCode(testEvent);

        expect(initializationResult).to.exist;
        expect(initializationResult).to.deep.equal({ result: 'NO_USER_CODE_FOUND' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(referralInvocation);
        expect(findPossibleRequestStub).to.have.not.been.called;
        expect(insertFriendRequestStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const testEvent = {
            targetUserId: testTargetUserId,
            referralCodeUsed: testReferralCode,
            countryCode: testCountryCode,
            emailAddress: testUserEmail
        };

        lamdbaInvokeStub.throws(new Error('Error!'));

        const initializationResult = await handler.initiateRequestFromReferralCode(testEvent);

        expect(initializationResult).to.exist;
        expect(initializationResult).to.deep.equal({ result: 'FAILURE' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(referralInvocation);
        expect(findPossibleRequestStub).to.have.not.been.called;
        expect(insertFriendRequestStub).to.have.not.been.called;
    });
});
