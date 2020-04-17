'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

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
    const testInitiatedUserId = uuid();
    const testRequestId = uuid();
    const testAccountId = uuid();

    const friendRequestTable = config.get('tables.friendRequestTable');
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
        const accountTable = config.get('tables.accountTable');
        const selectQuery = `select owner_user_id from ${accountTable} where account_id = $1`;

        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.userId')}::${testAccountId}`).resolves();
        queryStub.withArgs(selectQuery, [testAccountId]).resolves([{ 'owner_user_id': testSystemId }]);
        redisGetStub.withArgs(`${config.get('cache.keyPrefixes.profile')}::${testSystemId}`).resolves(JSON.stringify(expectedUserProfile));

        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Gets the user ids of a users friends', async () => {
        const testAcceptedUserId = uuid();
        const friendTable = config.get('tables.friendTable');

        const selectQuery = `select accepted_user_id from ${friendTable} where initiated_user_id = $1`;
        queryStub.withArgs(selectQuery, [testSystemId]).resolves([{ 'accepted_user_id': testAcceptedUserId }]);

        const resultOfFetch = await persistence.getFriendIdsForUser({ systemWideUserId: testSystemId });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([testAcceptedUserId]);
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
        const testContactDetail = 'user@email.com';
        fetchStub.withArgs(emailTable, { emailAddress: testContactDetail }).resolves({ systemWideUserId: testTargetUserId });
        const resultOfFetch = await persistence.fetchUserByContactDetail(testContactDetail, 'EMAIL');
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ systemWideUserId: testTargetUserId });
    });

    it('Fetches user by email', async () => {
        const testContactDetail = '27632390812';
        fetchStub.withArgs(phoneTable, { phoneNumber: testContactDetail }).resolves({ systemWideUserId: testTargetUserId });

        const resultOfFetch = await persistence.fetchUserByContactDetail(testContactDetail, 'PHONE');
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
});
