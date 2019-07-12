'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:profile:dynamo:test');
const config = require('config');
const moment = require('moment');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');

const fetchRowStub = sinon.stub();
const insertRowStub = sinon.stub();
const uuidStub = sinon.stub();
const momentStub = sinon.stub();

const testHelper = require('./test.helper');

const dynamo = proxyquire('../persistence/dynamodb', {
    'dynamo-common': {
        fetchSingleRow: fetchRowStub,
        insertNewRow: insertRowStub 
    },
    'uuid/v4': uuidStub,
    'moment': momentStub,
    '@noCallThru': true
});

const profileTable = config.get('tables.dynamo.profileTable');
const nationalIdTable = config.get('tables.dynamo.nationalIdTable');
const phoneTable = config.get('tables.dynamo.phoneTable');
const emailTable = config.get('tables.dynamo.emailTable');

const testSystemId = uuid();
const testClientId = 'some_country_client';
const testPhone = '16061110000';
const testEmail = 'lukesjordan@gmail.com';
const testNationalId = 'some-long-alpha-numeric';
const testTimeCreated = moment();

const testUserPassed = {
    clientId: testClientId,
    defaultFloatId: 'primary_mmkt_fund',
    personalName: 'Luke',
    familyName: 'Jordan',
    primaryPhone: testPhone,
    nationalId: testNationalId,
    userStatus: 'CREATED',
    kycStatus: 'CONTACT_VERIFIED'
};

const wellFormedNewItemToDdb = {
    systemWideUserId: testSystemId,
    creationTimeEpochMillis: testTimeCreated.valueOf(),
    clientId: testClientId,
    floatId: testUserPassed.defaultFloatId,
    personalName: testUserPassed.personalName,
    familyName: testUserPassed.familyName,
    phoneNumber: testPhone,
    nationalId: testNationalId,
    userStatus: testUserPassed.userStatus,
    kycStatus: testUserPassed.kycStatus,
    updatedTimeEpochMillis: testTimeCreated.valueOf()
};

describe('*** UNIT TESTING PROFILE-DYNAMO HP ***', () => {

    const insertionSuccessResult = {
        result: 'SUCCESS'
    };

    beforeEach(() => {
        testHelper.resetStubs([fetchRowStub, insertRowStub, uuidStub]);
    });

    it('Inserts a user row correctly', async () => {
        uuidStub.returns(testSystemId);
        momentStub.returns({ valueOf: () => testTimeCreated.valueOf() });
        
        fetchRowStub.withArgs(nationalIdTable, { clientId: testClientId, nationalId: testNationalId }).resolves({ });
        insertRowStub.withArgs(nationalIdTable, ['clientId', 'nationalId'], { clientId: testClientId, nationalId: testNationalId, systemWideUserId: testSystemId }).
            resolves(insertionSuccessResult);
        fetchRowStub.withArgs(phoneTable, { phoneNumber: testPhone }).resolves({ });
        insertRowStub.withArgs(phoneTable, ['phoneNumber'], { phoneNumber: testPhone, systemWideUserId: testSystemId }).resolves(insertionSuccessResult);

        insertRowStub.withArgs(profileTable, ['systemWideUserId'], wellFormedNewItemToDdb).resolves(insertionSuccessResult);

        const insertionResult = await dynamo.insertUserProfile(testUserPassed);
        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ result: 'SUCCESS', systemWideUserId: testSystemId, creationTimeEpochMillis: testTimeCreated.valueOf() });
    });

    it('Checks for user with existing details', async () => {
        fetchRowStub.withArgs(nationalIdTable, { clientId: testClientId, nationalId: testNationalId }).resolves({ 
            clientId: testClientId,
            nationalId: testNationalId,
            systemWideUserId: testSystemId
        });
        fetchRowStub.withArgs(phoneTable, { phoneNumber: testPhone }).resolves({ phoneNumber: testPhone, systemWideUserId: testSystemId });
        fetchRowStub.withArgs(emailTable, { emailAddress: testEmail }).resolves({ emailAddress: testEmail, systemWideUserId: testSystemId });
        
        const fetchById = await dynamo.fetchUserByNationalId(testClientId, testNationalId);
        const fetchByPhone = await dynamo.fetchUserByPhone(testPhone);
        const fetchByEmail = await dynamo.fetchUserByEmail(testEmail);

        expect(fetchById).to.deep.equal({ systemWideUserId: testSystemId });
        expect(fetchByPhone).to.deep.equal({ systemWideUserId: testSystemId });
        expect(fetchByEmail).to.deep.equal({ systemWideUserId: testSystemId });
    });

    it('Checks for user with system ID', async () => {
        fetchRowStub.withArgs(profileTable, { systemWideUserId: testSystemId }).resolves(wellFormedNewItemToDdb);
        const userProfileRetrieved = await dynamo.fetchUserProfile(testSystemId);
        expect(userProfileRetrieved).to.deep.equal(wellFormedNewItemToDdb);
    });

    it('Returns gracefully when nothing is found', async () => {
        fetchRowStub.withArgs(profileTable, { systemWideUserId: testSystemId }).resolves({ });
        const userProfileRetrieved = await dynamo.fetchUserProfile(testSystemId);
        logger('Result of retrieval: ', userProfileRetrieved);
        expect(userProfileRetrieved).to.be.null;

        fetchRowStub.withArgs(nationalIdTable, { clientId: testClientId, nationalId: testNationalId }).resolves({ });
        const retrievedNational = await dynamo.fetchUserByNationalId(testClientId, testNationalId);
        expect(retrievedNational).to.be.null;

        fetchRowStub.withArgs(phoneTable, { phoneNumber: testPhone }).resolves({ });
        const retrievedPhone = await dynamo.fetchUserByPhone(testPhone);
        expect(retrievedPhone).to.be.null;

        fetchRowStub.withArgs(emailTable, { emailAddress: testEmail }).resolves({ });
        const retrievedEmail = await dynamo.fetchUserByEmail(testEmail);
        expect(retrievedEmail).to.be.null;
    });

    it('Updates a user row correctly', () => {

    });

    it('Handles possibility of concurrency', () => {
        // i.e., if two calls are made with same phone number, whichever one succeeds in the putitem to userphone first will go through
        // but note: handle case if one has say phone number and other has email + phone, so second may be first ... this race condition could be bad
        // which means point: make national ID required, and anything which fails there exits immediately, eliminates races at start (should)
    });

});
