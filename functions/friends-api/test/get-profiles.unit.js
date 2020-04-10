'use strict';

// const logger = require('debug')('jupiter:friends:test');

const config = require('config');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();

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

const persistence = proxyquire('../persistence/get-profiles', {
    'ioredis': MockRedis,
    'rds-common': MockRdsConnection,
    'dynamo-common': {
        'fetchSingleRow': fetchStub
    },
    '@noCallThru': true
});

const expectedProfileColumns = [
    'systemWideUserId',
    'personalName',
    'familyName',
    'calledName',
    'emailAddress',
    'phoneNumber'
];

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST GET PROFILE FUNCTIONS ***', () => {
    const testSystemId = uuid();
    const testAccountId = uuid();

    const profileTable = config.get('tables.dynamoProfileTable');

    const expectedUserProfile = {
        systemWideUserId: testSystemId,
        personalName: 'Li',
        familyName: 'Er',
        phoneNumber: '16061110000',
        calledName: 'Lao Tzu',
        emailAddress: 'laotzu@tao.com'
    };

    beforeEach(() => {
        resetStubs(fetchStub, queryStub, redisGetStub, redisSetStub);
    });

    it('Fetches user profile from db, given user id', async () => {
        const profileFetchEvent = { systemWideUserId: testSystemId };
        fetchStub.withArgs(profileTable, profileFetchEvent, expectedProfileColumns).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile(profileFetchEvent);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
        expect(fetchStub).to.have.been.calledOnceWithExactly(profileTable, profileFetchEvent, expectedProfileColumns);
    });

    it('Fetches user profile from db, given account ids', async () => {
        redisGetStub.withArgs(testAccountId).resolves(testSystemId);
        fetchStub.withArgs(profileTable, { systemWideUserId: testSystemId }, expectedProfileColumns).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Fetches user profile from cache, given user id', async () => {
        redisGetStub.withArgs(testSystemId).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile({ systemWideUserId: testSystemId });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Fetches user profile from cache, given account id', async () => {
        redisGetStub.withArgs(testAccountId).resolves(testSystemId);
        redisGetStub.withArgs(testSystemId).resolves(expectedUserProfile);
        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Fetches user user from DB, given account id', async () => {
        const accountTable = config.get('tables.accountTable');
        const selectQuery = `select owner_user_id from ${accountTable} where account_id = $1`;

        redisGetStub.withArgs(testAccountId).resolves();
        queryStub.withArgs(selectQuery, [testAccountId]).resolves([{ 'owner_user_id': testSystemId }]);
        redisGetStub.withArgs(testSystemId).resolves(expectedUserProfile);

        const resultOfFetch = await persistence.fetchUserProfile({ accountIds: [testAccountId, testAccountId] });
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedUserProfile);
    });

    it('Gets the user ids of a users friends', async () => {
        const testAcceptedUserId = uuid();
        const friendTable = config.get('tables.friendTable');

        const selectQuery = `select accepted_user_id from ${friendTable} where initiated_user_id = $1`;
        queryStub.withArgs(selectQuery, [testSystemId]).resolves([{ 'accepted_user_id': testAcceptedUserId }]);

        const fetchResult = await persistence.getFriendIdsForUser({ systemWideUserId: testSystemId });
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal([testAcceptedUserId]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testSystemId]);
    });
});
