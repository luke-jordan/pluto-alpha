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
const countMutualFriendsStub = sinon.stub();

const testSystemId = uuid();
const testAccountId = uuid();
const testInitiatedUserId = uuid();
const testRelationshipId = uuid();
const momentStub = sinon.stub();

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
        'countMutualFriends': countMutualFriendsStub,
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
    'ioredis': MockRedis,
    'moment': momentStub
});

const resetStubs = () => helper.resetStubs(getFriendsStub, fetchProfileStub, fetchAccountStub, lamdbaInvokeStub, redisGetStub);

describe('*** UNIT TEST FRIEND PROFILE EXTRACTION ***', () => {
    const testActivityDate = moment();

    const mockProfile = (systemWideUserId) => ({
        systemWideUserId,
        personalName: 'Lie',
        familyName: 'Yukou',
        phoneNumber: '17923835934',
        calledName: 'Liezi',
        emailAddress: 'liezi@tao.com'
    });

    const expectedFriendship = (relationshipId) => ({
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

    const expectedsavingHeat = '0.00';

    const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
    const [firstAccId, secondAccId, thirdAccId] = [uuid(), uuid(), uuid()];

    const mockSavingHeatResponse = {
        statusCode: 200,
        userHeatMap: {
            [firstUserId]: { currentLevel: 'hot-level-id', recentActivity: { USER_SAVING_EVENT: { creationTime: testActivityDate.format() }}},
            [secondUserId]: { currentLevel: 'blazing-level-id', recentActivity: { USER_SAVING_EVENT: { creationTime: testActivityDate.format() }}},
            [thirdUserId]: { currentLevel: 'cold-level-id', recentActivity: { USER_SAVING_EVENT: { creationTime: testActivityDate.format() }}},
            [testSystemId]: { currentLevel: 'cold-level-id', recentActivity: { USER_SAVING_EVENT: { creationTime: testActivityDate.format() }}}
        }
    };

    const mockSavingHeatInCache = {
        savingHeat: `${expectedsavingHeat}`,
        recentActivity: { USER_SAVING_EVENT: { creationTime: testActivityDate.format() }}
    };

    const expectedResultFromCache = (shareItems) => ({
        shareItems,
        savingHeat: `${expectedsavingHeat}`,
        lastActivity: { USER_SAVING_EVENT: { creationTime: testActivityDate.valueOf() }}
    });

    const mockResponseFromCache = (accountId) => JSON.stringify({ accountId, ...mockSavingHeatInCache });

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
        const shareItems = ['LAST_ACTIVITY', 'LAST_AMOUNT'];

        const userIds = [firstUserId, secondUserId, thirdUserId, testSystemId];

        const accountIds = [firstAccId, secondAccId, thirdAccId, testAccountId];
        
        const includeLastActivityOfType = config.get('share.activities');
        
        const heatPayload = { userIds: [firstUserId, secondUserId, thirdUserId, testSystemId], includeLastActivityOfType };
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.calcSavingHeat'), false, heatPayload);
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');

        const mockFriend = (id) => mockFriendship(id, shareItems);
        const mockFriendList = { [testSystemId]: userIds.filter((id) => id !== testSystemId).map(mockFriend) };
        getFriendsStub.withArgs(testSystemId).resolves(mockFriendList);

        userIds.forEach((systemWideUserId) => fetchProfileStub.withArgs({ systemWideUserId }).resolves(mockProfile(systemWideUserId)));
        userIds.forEach((userId, index) => fetchAccountStub.withArgs(userId).resolves({ [userId]: accountIds[index] }));

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify(mockSavingHeatResponse) }) });
        
        redisGetStub.withArgs(testAccountId).resolves([mockResponseFromCache(testAccountId)]);
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([mockResponseFromCache(firstAccId), null, null]);

        // make sure one of these at least is zero, to cover possible bugs from filters
        countMutualFriendsStub.withArgs(testSystemId, [firstUserId, secondUserId, thirdUserId]).resolves([
            { [firstUserId]: 5 },
            { [secondUserId]: 0 },
            { [thirdUserId]: 13 }
        ]);

        momentStub.returns({ valueOf: () => testActivityDate.valueOf() });

        const fetchResult = await handler.obtainFriends(testEvent);
        const resultBody = helper.standardOkayChecks(fetchResult);
        const expectedBody = [
            {
                ...expectedFriendship(testRelationshipId),
                savingHeat: `${expectedsavingHeat}`,
                shareItems,
                lastActivity: {
                    USER_SAVING_EVENT: { creationTime: testActivityDate.valueOf() }
                },
                numberOfMutualFriends: 5
            },
            {
                ...expectedFriendship(testRelationshipId),
                savingHeat: expectedsavingHeat,
                shareItems,
                lastActivity: {
                    USER_SAVING_EVENT: { creationTime: testActivityDate.valueOf() }
                },
                numberOfMutualFriends: 0
            },
            {
                ...expectedFriendship(testRelationshipId),
                savingHeat: expectedsavingHeat,
                shareItems,
                lastActivity: {
                    USER_SAVING_EVENT: { creationTime: testActivityDate.valueOf() }
                },
                numberOfMutualFriends: 13
            },
            { relationshipId: 'SELF', savingHeat: `${expectedsavingHeat}` }
        ];

        expect(resultBody).to.deep.equal(expectedBody);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
    });

    it('Fetches admin friends too', async () => {
        const shareItems = ['LAST_ACTIVITY', 'LAST_AMOUNT'];
        const testEvent = helper.wrapEvent({}, testSystemId, 'SYSTEM_ADMIN');
       
        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(mockProfile(testSystemId));
        
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        fetchAccountStub.withArgs(testSystemId).resolves({ [testSystemId]: testAccountId });

        [firstUserId, secondUserId, thirdUserId].map((userId) => countMutualFriendsStub.withArgs(testSystemId, [userId]).resolves([{ [userId]: 12 }]));
        redisGetStub.withArgs(testAccountId).resolves([mockResponseFromCache(testAccountId)]);
        countMutualFriendsStub.withArgs(testSystemId, [firstUserId, secondUserId, thirdUserId]).resolves([
            { [firstUserId]: 21 },
            { [secondUserId]: 34 },
            { [thirdUserId]: 55 }
        ]);

        getFriendsStub.withArgs(testSystemId).resolves({
            [testSystemId]: [
                mockFriendship(firstUserId, shareItems),
                mockFriendship(secondUserId, shareItems),
                mockFriendship(thirdUserId, shareItems)
            ]
        });

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify(mockSavingHeatResponse) }) });

        momentStub.returns({ valueOf: () => testActivityDate.valueOf() });

        const fetchResult = await handler.obtainFriends(testEvent);
        const resultBody = helper.standardOkayChecks(fetchResult);
       
        expect(resultBody).to.deep.equal([
            { ...expectedFriendship(testRelationshipId), ...expectedResultFromCache(shareItems), numberOfMutualFriends: 21 },
            { ...expectedFriendship(testRelationshipId), ...expectedResultFromCache(shareItems), numberOfMutualFriends: 34 },
            { ...expectedFriendship(testRelationshipId), ...expectedResultFromCache(shareItems), numberOfMutualFriends: 55 },
            { relationshipId: 'SELF', savingHeat: `${expectedsavingHeat}` }
        ]);
    });

    it('Fetches friends for admin provided user', async () => {
        const shareItems = ['LAST_ACTIVITY', 'LAST_AMOUNT'];
        const testEvent = helper.wrapEvent({ systemWideUserId: testInitiatedUserId }, testSystemId, 'SYSTEM_ADMIN');

        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(mockProfile(testInitiatedUserId));

        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        fetchAccountStub.withArgs(testInitiatedUserId).resolves({ [testInitiatedUserId]: testAccountId });

        [firstUserId, secondUserId, thirdUserId].map((userId) => countMutualFriendsStub.withArgs(testInitiatedUserId, [userId]).resolves([{ [userId]: 12 }]));
        redisGetStub.withArgs(testAccountId).resolves([mockResponseFromCache(testAccountId)]);
        countMutualFriendsStub.withArgs(testInitiatedUserId, [firstUserId, secondUserId, thirdUserId]).resolves([
            { [firstUserId]: 89 },
            { [secondUserId]: 14 },
            { [thirdUserId]: 23 }
        ]);

        getFriendsStub.withArgs(testInitiatedUserId).resolves({
            [testInitiatedUserId]: [
                mockFriendship(firstUserId, shareItems),
                mockFriendship(secondUserId, shareItems),
                mockFriendship(thirdUserId, shareItems)
            ]
        });

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify(mockSavingHeatResponse) }) });

        momentStub.returns({ valueOf: () => testActivityDate.valueOf() });

        const fetchResult = await handler.obtainFriends(testEvent);
        
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            { ...expectedFriendship(testRelationshipId), ...expectedResultFromCache(shareItems), numberOfMutualFriends: 89 },
            { ...expectedFriendship(testRelationshipId), ...expectedResultFromCache(shareItems), numberOfMutualFriends: 14 },
            { ...expectedFriendship(testRelationshipId), ...expectedResultFromCache(shareItems), numberOfMutualFriends: 23 },
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
