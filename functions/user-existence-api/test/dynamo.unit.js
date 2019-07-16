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
const updateRowStub = sinon.stub();
const uuidStub = sinon.stub();
const momentStub = sinon.stub();

const testHelper = require('./test.helper');

const dynamo = proxyquire('../persistence/dynamodb', {
    'dynamo-common': {
        fetchSingleRow: fetchRowStub,
        insertNewRow: insertRowStub,
        updateRow: updateRowStub
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
const testCountryCode = 'USA';
const testPhone = '16061110000';
const testEmail = 'lukesjordan@gmail.com';
const testNationalId = 'some-long-alpha-numeric';
const testTimeCreated = moment();

const testUserPassed = {
    clientId: testClientId,
    defaultFloatId: 'primary_mmkt_fund',
    defaultCurrency: 'USD',
    defaultTimezone: 'America/New_York',
    personalName: 'Luke',
    familyName: 'Jordan',
    primaryPhone: testPhone,
    countryCode: testCountryCode,
    nationalId: testNationalId,
    userStatus: 'CREATED',
    kycStatus: 'CONTACT_VERIFIED',
    passwordSet: false
};

const wellFormedNewItemToDdb = {
    systemWideUserId: testSystemId,
    creationTimeEpochMillis: testTimeCreated.valueOf(),
    clientId: testClientId,
    floatId: testUserPassed.defaultFloatId,
    defaultCurrency: 'USD',
    defaultTimezone: 'America/New_York',
    personalName: testUserPassed.personalName,
    familyName: testUserPassed.familyName,
    phoneNumber: testPhone,
    countryCode: testCountryCode,
    nationalId: testNationalId,
    userStatus: testUserPassed.userStatus,
    kycStatus: testUserPassed.kycStatus,
    securedStatus: 'NO_PASSWORD',
    updatedTimeEpochMillis: testTimeCreated.valueOf()
};

describe('*** UNIT TESTING PROFILE-DYNAMO HP ***', () => {

    const insertionSuccessResult = {
        result: 'SUCCESS'
    };

    beforeEach(() => {
        testHelper.resetStubs([fetchRowStub, insertRowStub, uuidStub, momentStub]);
    });

    it('Inserts a user row correctly', async () => {
        uuidStub.returns(testSystemId);
        momentStub.returns({ valueOf: () => testTimeCreated.valueOf() });
        
        fetchRowStub.withArgs(nationalIdTable, { countryCode: testCountryCode, nationalId: testNationalId }).resolves({ });
        insertRowStub.withArgs(nationalIdTable, ['countryCode', 'nationalId'], { countryCode: testCountryCode, nationalId: testNationalId, 
            systemWideUserId: testSystemId }).resolves(insertionSuccessResult);
        fetchRowStub.withArgs(phoneTable, { phoneNumber: testPhone }).resolves({ });
        insertRowStub.withArgs(phoneTable, ['phoneNumber'], { phoneNumber: testPhone, systemWideUserId: testSystemId }).resolves(insertionSuccessResult);

        logger('Expecting profile table: ', profileTable);
        insertRowStub.withArgs(profileTable, ['systemWideUserId'], sinon.match(wellFormedNewItemToDdb)).resolves(insertionSuccessResult);

        const insertionResult = await dynamo.insertUserProfile(testUserPassed);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.deep.equal({ result: 'SUCCESS', systemWideUserId: testSystemId, creationTimeEpochMillis: testTimeCreated.valueOf() });
    });

    it('Checks for user with existing details', async () => {
        fetchRowStub.withArgs(nationalIdTable, { countryCode: testCountryCode, nationalId: testNationalId }).resolves({ 
            countryCode: testCountryCode,
            nationalId: testNationalId,
            systemWideUserId: testSystemId
        });
        fetchRowStub.withArgs(phoneTable, { phoneNumber: testPhone }).resolves({ phoneNumber: testPhone, systemWideUserId: testSystemId });
        fetchRowStub.withArgs(emailTable, { emailAddress: testEmail }).resolves({ emailAddress: testEmail, systemWideUserId: testSystemId });
        
        const fetchById = await dynamo.fetchUserByNationalId(testCountryCode, testNationalId);
        const fetchByPhone = await dynamo.fetchUserByPhone(testPhone);
        const fetchByEmail = await dynamo.fetchUserByEmail(testEmail);

        expect(fetchById).to.equal(testSystemId);
        expect(fetchByPhone).to.equal(testSystemId);
        expect(fetchByEmail).to.equal(testSystemId);
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

        fetchRowStub.withArgs(nationalIdTable, { countryCode: testCountryCode, nationalId: testNationalId }).resolves({ });
        const retrievedNational = await dynamo.fetchUserByNationalId(testClientId, testNationalId);
        expect(retrievedNational).to.be.null;

        fetchRowStub.withArgs(phoneTable, { phoneNumber: testPhone }).resolves({ });
        const retrievedPhone = await dynamo.fetchUserByPhone(testPhone);
        expect(retrievedPhone).to.be.null;

        fetchRowStub.withArgs(emailTable, { emailAddress: testEmail }).resolves({ });
        const retrievedEmail = await dynamo.fetchUserByEmail(testEmail);
        expect(retrievedEmail).to.be.null;
    });

    it('Updates a user row correctly given a status dict', async () => {
        const testTimeUpdatedMillis = moment().valueOf();
        momentStub.returns({ valueOf: () => testTimeUpdatedMillis });

        const expectedUpdateParams = {
            tableName: profileTable,
            itemKey: { systemWideUserId: testSystemId },
            updateExpression: 'set user_status = :ust, kyc_status = :kst, secured_status = :sst, updated_time_epoch_millis = :utime',
            substitutionDict: { ':ust': 'ACCOUNT_OPENED', ':kst': 'VERIFIED_AS_PERSON', ':sst': 'PASSWORD_SET', ':utime': testTimeUpdatedMillis },
            returnOnlyUpdated: true
        };
        
        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: {
                userStatus: 'ACCOUNT_OPENED',
                kycStatus: 'VERIFIED_AS_PERSON',
                securedStatus: 'PASSWORD_SET',
                updatedTimeEpochMillis: testTimeUpdatedMillis
            }
        };

        updateRowStub.withArgs(sinon.match(expectedUpdateParams)).resolves(expectedResult);
        
        const statusUpdates = {
            userStatus: 'ACCOUNT_OPENED',
            kycStatus: 'VERIFIED_AS_PERSON',
            securedStatus: 'PASSWORD_SET'
        };

        const resultOfUpdate = await dynamo.updateUserStatus(testSystemId, statusUpdates);
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('result', 'SUCCESS');
        expect(resultOfUpdate).to.have.property('updatedTimeEpochMillis', testTimeUpdatedMillis);
    });

    // todo : also put in transactions, as this one is delicate (but also, if user ID for new email address is existing, then allow)
    // it('Updates a user contact details correctly, if new contact detail not taken', async () => {
    //     const testTimeUpdatedMillis = moment().valueOf();

    //     const newPhoneNumber = '27650005555';
    //     fetchRowStub.withArgs(phoneTable, { phoneNumber: newPhoneNumber }).resolves({ });
        
    //     const expectedProfileUpdateParams = {
    //         tableName: profileTable,
    //         itemKey: { systemWideUserId: testSystemId },
    //         updateExpression: 'set phone_number = :p',
    //         substitutionDict: { ':p': newPhoneNumber },
    //         returnOnlyUpdated: true
    //     };

    //     // const expected;
    // });

    it('Updates a user last login correctly', async () => {
        const lastLoginTimeMillis = moment().valueOf();
        const expectedUpdateParams = {
            tableName: profileTable,
            itemKey: { systemWideUserId: testSystemId },
            updateExpression: 'set last_login_time_millis = :llt',
            substitutionDict: { ':llt': lastLoginTimeMillis },
            returnOnlyUpdated: true
        };

        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: {
                lastLoginTimeMillis: lastLoginTimeMillis
            }
        };

        updateRowStub.withArgs(sinon.match(expectedUpdateParams)).resolves(expectedResult);

        const resultOfUpdate = await dynamo.updateUserLastLogin(testSystemId, lastLoginTimeMillis);
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('result', 'SUCCESS');
        expect(resultOfUpdate).to.have.property('lastLoginTimeMillis', lastLoginTimeMillis);
    });

    // todo : restore
    // it('Handles possibility of concurrency', () => {
        // i.e., if two calls are made with same phone number, whichever one succeeds in the putitem to userphone first will go through
        // but note: handle case if one has say phone number and other has email + phone, so second may be first ... this race condition could be bad
        // which means point: make national ID required, and anything which fails there exits immediately, eliminates races at start (should)
    // });

});
