'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const camelCaseKeys = require('camelcase-keys');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test-helper');

const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();
const fetchStub = sinon.stub();
const queryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
    }
}

class MockRedis {
    constructor () { 
        this.get = redisGetStub;
        this.set = redisSetStub;
    }
}

const persistence = proxyquire('../persistence/read.friends', {
    'ioredis': MockRedis,
    'rds-common': MockRdsConnection,
    'dynamo-common': {
        'fetchSingleRow': fetchStub,
        '@noCallThru': true
    },
    '@noCallThru': true
});

const expectedProfileColumns = [
    'system_wide_user_id',
    'personal_name',
    'family_name',
    'called_name',
    'emai_adress',
    'phone_number',
    'referral_code',
    'country_code',
    'user_status'
];

describe('*** UNIT TEST GET PROFILE FUNCTIONS ***', () => {
    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const testSystemId = uuid();
    const testTargetUserId = uuid();
    const testInitiatedUserId = uuid();
    const testRelationshipId = uuid();
    const testRequestId = uuid();
    const testAccountId = uuid();
    const testLogId = uuid();

    const friendRequestTable = config.get('tables.friendRequestTable');
    const accountTable = config.get('tables.accountTable');
    const profileTable = config.get('tables.profileTable');

    const expectedUserProfile = {
        systemWideUserId: testSystemId,
        personalName: 'Li',
        familyName: 'Er',
        phoneNumber: '16061110000',
        calledName: 'Lao Tzu',
        emailAddress: 'laotzu@tao.com',
        userStatus: 'USER_HAS_SAVED'
    };

    const friendRequestFromRds = {
        'request_id': testRequestId,
        'creation_time': testCreationTime,
        'updated_time': testUpdatedTime,
        'request_status': 'PENDING',
        'initiated_user_id': testInitiatedUserId,
        'targetUser_id': testTargetUserId,
        'target_contact_details': {
            'contactType': 'PHONE',
            'contactMethod': '27850324843'
        },
        'request_type': 'CREATE',
        'request_code': 'SPOOKY ACTION'
    };

    beforeEach(() => {
        helper.resetStubs(fetchStub, queryStub, redisGetStub, redisSetStub);
    });

    it('Fetches user profile from db, given user id', async () => {
        const profileFetchEvent = { systemWideUserId: testSystemId };
        fetchStub.withArgs(profileTable, profileFetchEvent, expectedProfileColumns).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile(profileFetchEvent);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
        expect(redisGetStub).to.have.been.called;
        expect(redisSetStub).to.have.been.calledOnceWithExactly(`FRIEND_PROFILE::${testSystemId}`, JSON.stringify(expectedUserProfile), 'EX', 25200);
    });

    it('Fetches user profile from db, given account ids', async () => {
        const testKey = `${config.get('cache.keyPrefixes.userId')}::${testAccountId}`;
        redisGetStub.withArgs(testKey).resolves(testSystemId);
        fetchStub.withArgs(profileTable, { systemWideUserId: testSystemId }, expectedProfileColumns).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Fetches user profile from cache, given user id', async () => {
        const testKey = `${config.get('cache.keyPrefixes.profile')}::${testSystemId}`;
        redisGetStub.withArgs(testKey).resolves(JSON.stringify(expectedUserProfile));
        const resultOfFetch = await persistence.fetchUserProfile({ systemWideUserId: testSystemId });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
        expect(redisSetStub).to.not.have.been.called;
    });

    it('Fetches user profile from cache, given account id', async () => {
        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.userId')}::${testAccountId}`).resolves(testSystemId);
        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.profile')}::${testSystemId}`).resolves(JSON.stringify(expectedUserProfile));
        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Forces cache refresh, if told to do so', async () => {
        const profileFetchEvent = { systemWideUserId: testSystemId, forceCacheReset: true };
        fetchStub.withArgs(profileTable, { systemWideUserId: testSystemId }, expectedProfileColumns).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile(profileFetchEvent);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
        expect(redisGetStub).to.not.have.been.called;
        expect(redisSetStub).to.have.been.calledOnceWithExactly(`FRIEND_PROFILE::${testSystemId}`, JSON.stringify(expectedUserProfile), 'EX', 25200);
    });

    it('Fetches user user from DB, given account id', async () => {
        const selectQuery = `select owner_user_id from ${accountTable} where account_id = $1`;

        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.userId')}::${testAccountId}`).resolves();
        queryStub.withArgs(selectQuery, [testAccountId]).resolves([{ 'owner_user_id': testSystemId }]);
        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.profile')}::${testSystemId}`).resolves(JSON.stringify(expectedUserProfile));

        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Fetches active friendships for user', async () => {
        const testAcceptedUserId = uuid();
        const friendshipTable = config.get('tables.friendshipTable');

        const acceptedSelectQuery = `select relationship_id, accepted_user_id, share_items from ${friendshipTable} where initiated_user_id = $1 and relationship_status = $2`;
        queryStub.onFirstCall().resolves([{
            'relationship_id': testRelationshipId,
            'accepted_user_id': testAcceptedUserId,
            'share_items': ['BALANCE', 'LAST_ACTIVITY_DATE']
        }]);

        const initiatedSelectQuery = `select relationship_id, initiated_user_id, share_items from ${friendshipTable} where accepted_user_id = $1 and relationship_status = $2`;
        queryStub.onSecondCall().resolves([{
            'relationship_id': testRelationshipId,
            'initiated_user_id': testInitiatedUserId,
            'share_items': ['LAST_ACTIVITY_AMOUNT']
        }]);

        const resultOfFetch = await persistence.fetchActiveSavingFriendsForUser(testSystemId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({
            [testSystemId]: [{
                relationshipId: testRelationshipId,
                acceptedUserId: testAcceptedUserId,
                shareItems: ['BALANCE', 'LAST_ACTIVITY_DATE']
            },
            {
                relationshipId: testRelationshipId,
                initiatedUserId: testInitiatedUserId,
                shareItems: ['LAST_ACTIVITY_AMOUNT']
            }]
        });

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(acceptedSelectQuery, [testSystemId, 'ACTIVE']);
        expect(queryStub).to.have.been.calledWithExactly(initiatedSelectQuery, [testSystemId, 'ACTIVE']);
    });

    it('Fetches friendship request by request id', async () => {
        const selectQuery = `select initiated_user_id, target_user_id from ${friendRequestTable} where request_id = $1`;
        queryStub.withArgs(selectQuery, [testRequestId]).resolves([{ 'initiated_user_id': testInitiatedUserId, 'target_user_id': testTargetUserId }]);
        const resultOfFetch = await persistence.fetchFriendshipRequestById(testRequestId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId });
    });

    it('Fetches friendship request by request code', async () => {
        const testRequestCode = 'REASON MAGNET';
        const selectQuery = `select initiated_user_id, target_user_id from ${friendRequestTable} where request_code = $1`;
        queryStub.withArgs(selectQuery, [testRequestCode]).resolves([{ 'initiated_user_id': testInitiatedUserId, 'target_user_id': testTargetUserId }]);
        const resultOfFetch = await persistence.fetchFriendshipRequestByCode(testRequestCode);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ initiatedUserId: testInitiatedUserId, targetUserId: testTargetUserId });
    });

    it('Finds possible friend request by contact method', async () => {
        const testContactMethod = 'user@domain.com';
        const selectQuery = `select request_id from ${friendRequestTable} where initiated_user_id = $1 ` +
            `and target_contact_details ->> 'contactMethod' = $2 order by creation_time desc limit 1`;

        queryStub.resolves([{ 'request_id': testRequestId }]);

        const resultOfFetch = await persistence.findPossibleFriendRequest(testInitiatedUserId, testContactMethod);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ requestId: testRequestId });
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testInitiatedUserId, testContactMethod]);

    });

    it('Fetches all active request codes', async () => {
        const selectQuery = `select request_code from ${friendRequestTable} where request_status = $1`;
        queryStub.withArgs(selectQuery, ['PENDING']).resolves([{ 'request_code': 'FLYING LOTUS' }, { 'request_code': 'ACTIVE MANTIS' }]);
        const resultOfFetch = await persistence.fetchActiveRequestCodes();
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(['FLYING LOTUS', 'ACTIVE MANTIS']);
    });

    it('Fetches friend requests for user', async () => {
        const expectedFriendRequest = camelCaseKeys(friendRequestFromRds);

        const receivedQuery = `select * from ${friendRequestTable} where target_user_id = $1 and request_status = $2`;
        const initiatedQuery = `select * from ${friendRequestTable} where initiated_user_id = $1 and request_status = $2`;

        queryStub.withArgs(receivedQuery, [testTargetUserId, 'PENDING']).resolves([friendRequestFromRds]);
        queryStub.withArgs(initiatedQuery, [testTargetUserId, 'PENDING']).resolves([friendRequestFromRds]);

        const resultOfFetch = await persistence.fetchFriendRequestsForUser(testTargetUserId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedFriendRequest, expectedFriendRequest]);
        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(receivedQuery, [testTargetUserId, 'PENDING']);
        expect(queryStub).to.have.been.calledWithExactly(initiatedQuery, [testTargetUserId, 'PENDING']);
    });

    it('Fetches account id for user', async () => {
        const selectQuery = `select account_id from ${accountTable} where owner_user_id = $1`;
        queryStub.withArgs(selectQuery, [testSystemId]).resolves([{ 'account_id': testAccountId }]);
        const resultOfFetch = await persistence.fetchAccountIdForUser(testSystemId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ [testSystemId]: testAccountId });
    });

    it('Counts mutual friends between two users', async () => {
        const [firstUserId, secondUserId] = [uuid(), uuid()];
        const testAcceptedUserId = uuid();
        const friendshipTable = config.get('tables.friendshipTable');

        const acceptedSelectQuery = `select relationship_id, accepted_user_id, share_items from ${friendshipTable} where initiated_user_id = $1 and relationship_status = $2`;
        queryStub.onFirstCall().resolves([{
            'relationship_id': testRelationshipId,
            'accepted_user_id': testAcceptedUserId,
            'share_items': ['BALANCE', 'LAST_ACTIVITY_DATE']
        }]);

        const initiatedSelectQuery = `select relationship_id, initiated_user_id, share_items from ${friendshipTable} where accepted_user_id = $1 and relationship_status = $2`;
        queryStub.resolves([{
            'relationship_id': testRelationshipId,
            'initiated_user_id': testInitiatedUserId,
            'share_items': ['LAST_ACTIVITY_AMOUNT']
        }]);

        const mutualFriendCount = await persistence.countMutualFriends(testTargetUserId, [firstUserId, secondUserId]);

        expect(mutualFriendCount).to.exist;
        expect(mutualFriendCount).to.deep.equal([{ [firstUserId]: 1 }, { [secondUserId]: 1 }]);
        expect(queryStub.callCount).to.equal(6);
        expect(queryStub).to.have.been.calledWithExactly(acceptedSelectQuery, [testTargetUserId, 'ACTIVE']);
        expect(queryStub).to.have.been.calledWithExactly(initiatedSelectQuery, [firstUserId, 'ACTIVE']);
        expect(queryStub).to.have.been.calledWithExactly(initiatedSelectQuery, [secondUserId, 'ACTIVE']);
    });

    it('Fetches alert logs for user', async () => {
        const testLogType = 'FRIENDSHIP_REQUEST';
        const testLogObject = {
            'log_id': testLogId,
            'request_id': testRequestId,
            'log_type': testLogType,
            'log_context': camelCaseKeys(friendRequestFromRds),
            'to_alert_user_id': [testTargetUserId],
            'is_alert_active': true
        };

        const selectQuery = `select * from ${config.get('tables.friendLogTable')} where is_alert_active = true and ` +
            `$1 = any(to_alert_user_id) and not($1 = any(alerted_user_id)) and log_type in ($2)`;

        queryStub.resolves([testLogObject, testLogObject]);

        const resultOfFetch = await persistence.fetchAlertLogsForUser(testSystemId, [testLogType]);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([camelCaseKeys(testLogObject), camelCaseKeys(testLogObject)]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testSystemId, testLogType]);
    });
});
