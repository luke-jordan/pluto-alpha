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
const getFriendsStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchAccountStub = sinon.stub();
const fetchProfileStub = sinon.stub();

const testSystemId = uuid();
const testAccountId = uuid();
const testInitiatedUserId = uuid();
const testRelationshipId = uuid();

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
        'fetchAccountIdForUser': fetchAccountStub,
        'fetchActiveSavingFriendsForUser': getFriendsStub,
        'fetchUserProfile': fetchProfileStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        '@noCallThru': true
    },
    'publish-common': {
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'ioredis': MockRedis
});

const resetStubs = () => helper.resetStubs(getFriendsStub, fetchProfileStub, fetchAccountStub, lamdbaInvokeStub, redisGetStub);

describe('*** UNIT TEST FRIEND PROFILE EXTRACTION ***', () => {
    const testActivityDate = moment().format();

    const mockProfile = (systemWideUserId) => ({
        systemWideUserId,
        personalName: 'Lie',
        familyName: 'Yukou',
        phoneNumber: '17923835934',
        calledName: 'Liezi',
        emailAddress: 'liezi@tao.com'
    });

    const expectedProfile = (relationshipId) => ({
        relationshipId,
        personalName: 'Lie',
        familyName: 'Yukou',
        calledName: 'Liezi',
        contactMethod: '17923835934'
    });

    const mockFriendship = (userId, shareItems) => ({
        relationshipId: testRelationshipId,
        acceptedUserId: userId,
        shareItems
    });

    const expectedsavingHeat = 23.71;

    const [firstAccId, secondAccId, thirdAccId] = [uuid(), uuid(), uuid()];

    const mockResponseFromLambda = {
        details: [{
            accountId: secondAccId,
            savingHeat: `${expectedsavingHeat}`,
            shareItems: [{
                USER_SAVING_EVENT: {
                    lastActivityDate: testActivityDate,
                    lastActivityAmount: { amount: '2000', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                }
            }]
        },
        {
            accountId: thirdAccId,
            savingHeat: `${expectedsavingHeat}`,
            shareItems: [{
                BOOST_REDEMPTION: {
                    lastActivityDate: testActivityDate,
                    lastActivityAmount: { amount: '500', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                }
            }]
        }]
    };

    const expectedResultFromCache = {
        savingHeat: `${expectedsavingHeat}`,
        shareItems: [{
            WITHDRAWAL: {
                lastActivityDate: testActivityDate,
                lastActivityAmount: { amount: '100', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
            }
        }]
    };

    const mockResponseFromCache = (accountId) => ({
        accountId,
        ...expectedResultFromCache
    });

    beforeEach(() => {
        resetStubs();
    });

    it('Returns empty if user has no friends yet', async () => {
        getFriendsStub.resolves([]);
        const fetchResult = await handler.obtainFriends(helper.wrapEvent({}, testSystemId));
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([]));
    });

    it('Fetches profile and saving heat for friends and self', async () => {
        const shareItems = ['LAST_ACTIVITY_AMOUNT'];

        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const includeLastActivityOfType = config.get('share.activities');
        
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.calcSavingHeat'), false, { accountIds: [secondAccId, thirdAccId], includeLastActivityOfType });
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');

        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(mockProfile(testSystemId));

        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        fetchAccountStub.withArgs(testSystemId).resolves({ [testSystemId]: testAccountId });
        
        lamdbaInvokeStub.withArgs(lambdaArgs).returns({ promise: () => ({ Payload: JSON.stringify(mockResponseFromLambda) }) });
        
        getFriendsStub.withArgs(testSystemId).resolves({
            [testSystemId]: [
                mockFriendship(firstUserId, shareItems),
                mockFriendship(secondUserId, shareItems),
                mockFriendship(thirdUserId, shareItems)
            ]
        });
        redisGetStub.withArgs(testAccountId).resolves([JSON.stringify(mockResponseFromCache(testAccountId))]);
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify(mockResponseFromCache(firstAccId)),
            null,
            null
        ]);

        const fetchResult = await handler.obtainFriends(testEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            {
                ...expectedProfile(testRelationshipId),
                savingHeat: `${expectedsavingHeat}`,
                shareItems: [{
                    WITHDRAWAL: {
                        lastActivityAmount: { amount: '100', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }]
            },
            {
                ...expectedProfile(testRelationshipId),
                savingHeat: `${expectedsavingHeat}`,
                shareItems: [{
                    USER_SAVING_EVENT: {
                        lastActivityAmount: { amount: '2000', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }]  
            },
            {
                ...expectedProfile(testRelationshipId),
                savingHeat: `${expectedsavingHeat}`,
                shareItems: [{
                    BOOST_REDEMPTION: {
                        lastActivityAmount: { amount: '500', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }]
            },
            { relationshipId: 'SELF', savingHeat: `${expectedsavingHeat}` }
        ]));
    });

    it('Fetches admin friends too', async () => {
        const shareItems = ['LAST_ACTIVITY_DATE', 'LAST_ACTIVITY_AMOUNT'];
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const testEvent = helper.wrapEvent({}, testSystemId, 'SYSTEM_ADMIN');
       
        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(mockProfile(testSystemId));
        
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        fetchAccountStub.withArgs(testSystemId).resolves({ [testSystemId]: testAccountId });

        redisGetStub.withArgs(testAccountId).resolves([JSON.stringify(mockResponseFromCache(testAccountId))]);
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify(mockResponseFromCache(firstAccId)),
            JSON.stringify(mockResponseFromCache(secondAccId)),
            JSON.stringify(mockResponseFromCache(thirdAccId))
        ]);
        getFriendsStub.withArgs(testSystemId).resolves({
            [testSystemId]: [
                mockFriendship(firstUserId, shareItems),
                mockFriendship(secondUserId, shareItems),
                mockFriendship(thirdUserId, shareItems)
            ]
        });

        const fetchResult = await handler.obtainFriends(testEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            { ...expectedProfile(testRelationshipId), ...expectedResultFromCache },
            { ...expectedProfile(testRelationshipId), ...expectedResultFromCache },
            { ...expectedProfile(testRelationshipId), ...expectedResultFromCache },
            { relationshipId: 'SELF', savingHeat: `${expectedsavingHeat}` }
        ]));
    });

    it('Fetches friends for admin provided user', async () => {
        const shareItems = ['LAST_ACTIVITY_DATE', 'LAST_ACTIVITY_AMOUNT'];
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const testEvent = helper.wrapEvent({ systemWideUserId: testInitiatedUserId }, testSystemId, 'SYSTEM_ADMIN');

        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(mockProfile(testInitiatedUserId));

        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        fetchAccountStub.withArgs(testInitiatedUserId).resolves({ [testInitiatedUserId]: testAccountId });

        redisGetStub.withArgs(testAccountId).resolves([JSON.stringify(mockResponseFromCache(testAccountId))]);
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify(mockResponseFromCache(firstAccId)),
            JSON.stringify(mockResponseFromCache(secondAccId)),
            JSON.stringify(mockResponseFromCache(thirdAccId))
        ]);
        getFriendsStub.withArgs(testInitiatedUserId).resolves({
            [testInitiatedUserId]: [
                mockFriendship(firstUserId, shareItems),
                mockFriendship(secondUserId, shareItems),
                mockFriendship(thirdUserId, shareItems)
            ]
        });

        const fetchResult = await handler.obtainFriends(testEvent);
        
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            { ...expectedProfile(testRelationshipId), ...expectedResultFromCache },
            { ...expectedProfile(testRelationshipId), ...expectedResultFromCache },
            { ...expectedProfile(testRelationshipId), ...expectedResultFromCache },
            { relationshipId: 'SELF', savingHeat: `${expectedsavingHeat}` }
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
