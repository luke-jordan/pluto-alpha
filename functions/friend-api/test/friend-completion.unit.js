
'use strict';

// const logger = require('debug')('jupiter:friends:test');
// const config = require('config');
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
const publishUserEventStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const countMutualFriendsStub = sinon.stub();

const testAccountId = uuid();
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

const handler = proxyquire('../friend-request-handler', {
    './persistence/read.friends': {
        'fetchFriendshipRequestById': fetchRequestStub,
        'countMutualFriends': countMutualFriendsStub,
        'fetchAccountIdForUser': fetchAccountStub,
        'fetchUserProfile': fetchProfileStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        'insertFriendship': insertFriendshipStub,
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

const resetStubs = () => helper.resetStubs(fetchProfileStub, insertFriendshipStub, 
    fetchRequestStub, lamdbaInvokeStub, publishUserEventStub);

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

    const testProfile = {
        systemWideUserId: testInitiatedUserId,
        personalName: 'Yao',
        familyName: 'Shu',
        phoneNumber: '02130940334',
        calledName: 'Yao Shu',
        emailAddress: 'yaoshu@orkhon.com'
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
        acceptedUserId: testAcceptedUserId,
        relationshipStatus: 'ACTIVE',
        shareItems: ['LAST_ACTIVITY']
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Persists new friendship', async () => {
        fetchRequestStub.withArgs(testRequestId).resolves(testFriendRequest);
        fetchProfileStub.resolves(testProfile);
        insertFriendshipStub.withArgs(testRequestId, testInitiatedUserId, testTargetUserId).resolves(mockFriendship);
        publishUserEventStub.resolves({ result: 'SUCCESS' });
        countMutualFriendsStub.resolves([{ [testInitiatedUserId]: 23 }]);
        fetchAccountStub.resolves({ [testInitiatedUserId]: testAccountId });
        redisGetStub.resolves([JSON.stringify(mockResponseFromCache)]);

        const insertionResult = await handler.directRequestManagement(helper.wrapParamsWithPath({ requestId: testRequestId }, 'accept', testTargetUserId));
        
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal(helper.wrapResponse(expectedFriendship));
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
