'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const camelCaseKeys = require('camelcase-keys');

const proxyquire = require('proxyquire');
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
        'fetchSingleRow': fetchStub
    },
    '@noCallThru': true
});

const expectedProfileColumns = [
    'system_wide_user_id',
    'personal_name',
    'family_name',
    'called_name',
    'emai_adress',
    'phone_number'
];

describe('*** UNIT TEST GET PROFILE FUNCTIONS ***', () => {
    const testSystemId = uuid();
    const testTargetUserId = uuid();
    const testAcceptedUserId = uuid();
    const testInitiatedUserId = uuid();
    const testRelationshipId = uuid();
    const testRequestId = uuid();
    const testAccountId = uuid();

    const friendRequestTable = config.get('tables.friendRequestTable');
    const accountTable = config.get('tables.accountTable');
    const profileTable = config.get('tables.profileTable');
    const phoneTable = config.get('tables.phoneTable');
    const emailTable = config.get('tables.emailTable');

    const expectedUserProfile = {
        systemWideUserId: testSystemId,
        personalName: 'Li',
        familyName: 'Er',
        phoneNumber: '16061110000',
        calledName: 'Lao Tzu',
        emailAddress: 'laotzu@tao.com'
    };

    const friendshipFromRds = {
        'relationship_id': testRelationshipId,
        'initiated_user_id': testInitiatedUserId,
        'accepted_user_id': testAcceptedUserId,
        'share_items': ['LAST_ACTIVITY_AMOUNT', 'LAST_ACTIVITY_DATE']
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
    });

    it('Fetches user profile from cache, given account id', async () => {
        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.userId')}::${testAccountId}`).resolves(testSystemId);
        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.profile')}::${testSystemId}`).resolves(JSON.stringify(expectedUserProfile));
        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
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

    it('Gets the user ids of a users friends', async () => {
        const friendshipTable = config.get('tables.friendshipTable');
        const selectQuery = `select * from ${friendshipTable} where initiated_user_id = $1 or accepted_user_id = $2 and relationship_status = $3`;
        queryStub.withArgs(selectQuery, [testSystemId, testSystemId, 'ACTIVE']).resolves([friendshipFromRds, friendshipFromRds, friendshipFromRds]);
        const resultOfFetch = await persistence.fetchActiveSavingFriendsForUser(testSystemId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([camelCaseKeys(friendshipFromRds), camelCaseKeys(friendshipFromRds), camelCaseKeys(friendshipFromRds)]);
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

    it('Fetches user by email', async () => {
        const testContactDetails = { contactType: 'EMAIL', contactMethod: 'user@email.com' };
        fetchStub.withArgs(emailTable, { emailAddress: testContactDetails.contactMethod }).resolves({ systemWideUserId: testTargetUserId });
        const resultOfFetch = await persistence.fetchUserByContactDetail(testContactDetails);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ systemWideUserId: testTargetUserId });
    });

    it('Fetches user by phone', async () => {
        const testContactDetails = { contactType: 'PHONE', contactMethod: '27632390812' };
        fetchStub.withArgs(phoneTable, { phoneNumber: testContactDetails.contactMethod }).resolves({ systemWideUserId: testTargetUserId });
        const resultOfFetch = await persistence.fetchUserByContactDetail(testContactDetails);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ systemWideUserId: testTargetUserId });
    });

    it('Fetches all active request codes', async () => {
        const selectQuery = `select request_code from ${friendRequestTable} where request_status = $1`;
        queryStub.withArgs(selectQuery, ['PENDING']).resolves([{ 'request_code': 'FLYING LOTUS' }, { 'request_code': 'ACTIVE MANTIS' }]);
        const resultOfFetch = await persistence.fetchActiveRequestCodes();
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(['FLYING LOTUS', 'ACTIVE MANTIS']);
    });

    it('Fetches friend requests for user', async () => {
        const testCreationTime = moment().format();
        const testUpdatedTime = moment().format();
        const testCustomerMessage = 'Hi, this is John. Lets save some bones together.';

        const friendRequestFromRds = {
            'request_id': testRequestId,
            'creation_time': testCreationTime,
            'updated_time': testUpdatedTime,
            'request_status': 'PENDING',
            'customer_message': testCustomerMessage,
            'initiated_user_id': testInitiatedUserId,
            'targetUser_id': testTargetUserId,
            'target_contact_details': {
                'contactType': 'PHONE',
                'contactMethod': '27850324843'
            },
            'request_type': 'CREATE',
            'request_code': 'SPOOKY ACTION' // at a distance
        };

        const expectedFriendRequest = {
            requestId: testRequestId,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime,
            requestStatus: 'PENDING',
            customerMessage: testCustomerMessage,
            initiatedUserId: testInitiatedUserId,
            targetUserId: testTargetUserId,
            targetContactDetails: {
                contactType: 'PHONE',
                contactMethod: '27850324843'
            },
            requestType: 'CREATE',
            requestCode: 'SPOOKY ACTION'
        };

        const selectQuery = `select * from ${friendRequestTable} where target_user_id = $1 and request_status = $2`;

        queryStub.withArgs(selectQuery, [testTargetUserId, 'PENDING']).resolves([friendRequestFromRds]);

        const resultOfFetch = await persistence.fetchFriendRequestsForUser(testTargetUserId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedFriendRequest]);
    });

    it('Fetches account id for user', async () => {
        const selectQuery = `select account_id from ${accountTable} where owner_user_id = $1`;
        queryStub.withArgs(selectQuery, [testSystemId]).resolves([{ 'account_id': testAccountId }]);
        const resultOfFetch = await persistence.fetchAccountIdForUser(testSystemId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ [testSystemId]: testAccountId });
    });
});
