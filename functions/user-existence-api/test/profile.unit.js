'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:profile:test');
const uuid = require('uuid/v4');

const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
chai.use(require('chai-uuid'));

const testHelper = require('./test.helper');

// https://stackoverflow.com/questions/3825990/http-response-code-for-post-when-resource-already-exists
const httpStatusCodeForUserExists = 409;

const proxyquire = require('proxyquire').noCallThru();

const insertUserProfileStub = sinon.stub();
const updateUserProfileStub = sinon.stub();
const updateUserStatusStub = sinon.stub();
const updateUserLoginStub = sinon.stub();

// tables: UserProfileTable, NationalIdUserTable, EmailUserTable, PhoneUserTable
const fetchUserBySystemIdStub = sinon.stub();
const fetchUserByIdStub = sinon.stub();
const fetchUserByPhoneStub = sinon.stub();
const fetchUserByEmailStub = sinon.stub();

const fetchStubs = [fetchUserBySystemIdStub, fetchUserByIdStub, fetchUserByPhoneStub, fetchUserByEmailStub];
const dynamoStubs = {
    'insertUserProfile': insertUserProfileStub,
    'updateUserStatus': updateUserStatusStub,
    'updateUserProfile': updateUserProfileStub,
    'updateUserLastLogin': updateUserLoginStub,
    'fetchUserProfile': fetchUserBySystemIdStub,
    'fetchUserByNationalId': fetchUserByIdStub,
    'fetchUserByPhone': fetchUserByPhoneStub,
    'fetchUserByEmail': fetchUserByEmailStub
};

const handler = proxyquire('../profile-handler', {
    './persistence/dynamodb': dynamoStubs
});

const testSystemId = uuid();
const testClientId = 'some_country_client';
const testNationalId = 'some-social-security-number';
const testEmail = 'luke@jupitersave.com';
const testPhone = '16165550000';

const testUserContext = {
    systemWideId: testSystemId,
    userRole: 'ORDINARY_MEMBER'
};

const testAdminContext = {
    systemWideId: uuid(),
    userRole: 'SYSTEM_ADMIN'
};

const testSystemWorkerContext = {
    systemWideId: 'system-worker-X',
    userRole: 'SYSTEM_WORKER'
};

describe('*** UNIT TEST USER PROFILE *** FINDING USERS ***', () => {

    const testReturnedUser = {
        systemWideUserId: testSystemId,
        clientId: testClientId,
        nationalId: testNationalId,
        primaryPhone: testPhone,
        primaryEmail: testEmail,
        systemState: 'USER_HAS_SAVED',
        kycState: 'VERIFIED_AS_PERSON',
        kycRiskRating: 0,
        pwdStatus: 'PASSWORD_SET',
        userRole: 'ORDINARY_USER',
        tags: 'GRANTED_GIFT'
    };

    before(() => {
        testHelper.resetStubs(Object.values(dynamoStubs));
    });
    
    beforeEach(() => {
        testHelper.resetStubs(fetchStubs);
        fetchUserBySystemIdStub.withArgs(testSystemId).resolves(testReturnedUser);
    });

    afterEach(() => {
        testHelper.expectNoCalls(insertUserProfileStub, updateUserProfileStub);
    });

    it('Successfully find a user by client co and national ID number', async () => {
        fetchUserByIdStub.withArgs(testClientId, testNationalId).resolves(testSystemId);
        const fetchUserProjection = await handler.fetchUserByPersonalDetail({ clientId: testClientId, nationalId: testNationalId });
        const retrievedUser = testHelper.standardOkayChecks(fetchUserProjection);
        expect(retrievedUser).to.deep.equal({ systemWideUserId: testSystemId });
    });

    // note: will want to rate limit all of these (and/or the login lambda that sits in front of it)
    it('Successfully find a user by their primary email', async () => {
        fetchUserByEmailStub.withArgs(testEmail).resolves(testSystemId);
        const fetchUserProjection = await handler.fetchUserByPersonalDetail({ emailAddress: testEmail }); // will have to rate limit
        const retrievedUser = testHelper.standardOkayChecks(fetchUserProjection);
        expect(retrievedUser).to.deep.equal({ systemWideUserId: testSystemId });
    });

    it('Successfully find a user by their primary phone', async () => {
        fetchUserByPhoneStub.withArgs(testPhone).resolves(testSystemId);
        const fetchUserProjection = await handler.fetchUserByPersonalDetail({ phoneNumber: testPhone });
        const retrievedUser = testHelper.standardOkayChecks(fetchUserProjection);
        expect(retrievedUser).to.deep.equal({ systemWideUserId: testSystemId });
    });

    it('Successfully find a user by their system wide user ID', async () => {
        const userResult = await handler.fetchUserBySystemId({ }, testUserContext);
        const retrievedUser = testHelper.standardOkayChecks(userResult);
        expect(retrievedUser).to.deep.equal(testReturnedUser);

        const adminResult = await handler.fetchUserBySystemId({ systemWideId: testSystemId }, testAdminContext);
        const retreivedByAdmin = testHelper.standardOkayChecks(adminResult);
        expect(retreivedByAdmin).to.deep.equal(testReturnedUser);
    });

    it('Gracefully handle user not found', async () => {
        fetchUserBySystemIdStub.withArgs('non-existent-stub').resolves(null);
        const resultOfBlankCheck = await handler.fetchUserBySystemId({ systemWideId: 'non-existen-stub' }, testAdminContext);
        expect(resultOfBlankCheck).to.deep.equal({ statusCode: 404 });

        fetchUserByEmailStub.withArgs('surprise@nowhere.com').resolves(null);
        const resultOfEmpty = await handler.fetchUserByPersonalDetail({ emailAddress: 'surprise@nowhere.com' });
        expect(resultOfEmpty).to.deep.equal({ statusCode: 404 });
    });

    it('Throw error if no context, if not user calling, or if not system admin', async () => {
        const fishyRequest = await handler.fetchUserBySystemId({ systemWideId: 'some-other-person' }, testUserContext);
        const otherFishyRequest = await handler.fetchUserBySystemId({ systemWideId: 'third-person' });
        const thirdFishyRequest = await handler.fetchUserBySystemId({ systemWideId: 'fourth-person'}, { });

        expect(fishyRequest).to.deep.equal({ statusCode: 403 });
        expect(otherFishyRequest).to.deep.equal({ statusCode: 403 });
        expect(thirdFishyRequest).to.deep.equal({ statusCode: 403 });
    });

});

describe('*** UNIT TEST USER PROFILE *** INSERTING USERS ***', () => {

    // todo : note, may want to not do this until contact is verified
    const wellFormedRequest = {
        clientId: testClientId,
        defaultFloatId: 'primary_mmkt_fund',
        personalName: 'Luke',
        familyName: 'Jordan',
        primaryPhone: testPhone,
        nationalId: testNationalId,
        userStatus: 'CREATED',
        kycStatus: 'CONTACT_VERIFIED'
    };

    const testPersistedTime = moment.now().valueOf();

    const dynamoResponse = {
        result: 'SUCCESS',
        systemWideUserId: testSystemId,
        creationTimeEpochMillis: testPersistedTime
    };

    const expectedResponse = {
        systemWideUserId: testSystemId,
        persistedTimeMillis: testPersistedTime
    };

    before(() => {
        testHelper.resetStubs(Object.values(dynamoStubs));
    });
    
    beforeEach(() => {
        testHelper.resetStubs(fetchStubs);
        testHelper.resetStubs([insertUserProfileStub]);
    });

    afterEach(() => {
        testHelper.expectNoCalls(updateUserProfileStub);
    });

    it('Insert a new user profile, happy path, ID and phone number', async () => {
        // note: all the tests (for uniquneess etc) are done inside dynamo and tested in its tests
        insertUserProfileStub.withArgs(sinon.match(wellFormedRequest)).returns(dynamoResponse);
        const resultOfInsert = await handler.insertNewUser(wellFormedRequest);
        const insertBody = testHelper.standardOkayChecks(resultOfInsert);
        expect(insertBody).to.deep.equal(expectedResponse);
    });

    it('Fail if any part of user data is not unique', async () => {
        insertUserProfileStub.withArgs(sinon.match(wellFormedRequest)).returns({
            result: 'ERROR',
            message: 'NATIONAL_ID_TAKEN'
        });
        const resultOfInsert = await handler.insertNewUser(wellFormedRequest);
        const errorBody = testHelper.expectedErrorChecks(resultOfInsert, httpStatusCodeForUserExists);
        expect(errorBody).to.deep.equal({ message: 'A user with that national ID already exists', errorType: 'NATIONAL_ID_TAKEN', errorField: 'NATIONAL_ID' });
        // and so on, with others to test
    });

});


describe('*** UNIT TEST USER PROFILE *** UPDATING USERS ***', () => {

    beforeEach(() => testHelper.resetStubs(Object.values(dynamoStubs)));

    // note: we will definitely need to put this in a queue to prevent someone eventually altering it themselves
    it('Update a user KYC status', async () => {
        const updateEvent = {
            systemWideUserId: testUserContext.systemWideId, 
            updatedKycStatus: { changeTo: 'ACCOUNT_VERIFIED', reasonToLog: 'Check on ID number is positive' }
        };

        const expectedDynamoInstruction = {
            kycStatus: 'ACCOUNT_VERIFIED'
        };

        const updateTime = moment().valueOf();
        updateUserStatusStub.withArgs(testUserContext.systemWideId, expectedDynamoInstruction).
            resolves({ result: 'SUCCESS', updatedTimeEpochMillis: updateTime });
        const resultOfUpdate = await handler.updateUserStatus(updateEvent, testSystemWorkerContext);
        logger('Result of update: ', resultOfUpdate);
        const bodyOfResult = await testHelper.standardOkayChecks(resultOfUpdate);
        expect(bodyOfResult).to.deep.equal({ updatedTimeMillis: updateTime });
    });

    it('Throw security error if user is in suspended / KYC frozen state and non-system admin tries to update', async () => {
        const updateEvent = {
            systemWideUserId: 'sneaky-user-trying-dodgy-stuff',
            updatedKycStatus: { changeTo: 'ACCOUNT_VERIFIED', reasonToLog: 'Attempted endrun' }
        };
        const endRunContext = JSON.parse(JSON.stringify(testUserContext));
        endRunContext.systemWideUserId = 'sneaky-user-trying-dodgy-stuff';

        const bodyOfResult = await handler.updateUserStatus(updateEvent, endRunContext);
        expect(bodyOfResult).to.deep.equal({ statusCode: 403 });
    });

    // it('Throw validation errors if incorrect status', async () => {

    // });

    it('Update user system and secured status', async () => {
        const updateEvent = {
            systemWideUserId: testSystemId,
            updatedUserStatus: { changeTo: 'ACCOUNT_OPENED', reasonToLog: 'Completed first onboarding' },
            updatedSecurityStatus: { changeTo: 'PASSWORD_SET', reasonToLog: 'Completed first onboarding' }
        };

        const expectedInstruction = {
            userStatus: 'ACCOUNT_OPENED',
            securityStatus: 'PASSWORD_SET'
        };

        const updateTime = moment().valueOf();
        updateUserStatusStub.withArgs(testSystemId, expectedInstruction).resolves({ result: 'SUCCESS', updatedTimeEpochMillis: updateTime });

        const resultOfUpdate = await handler.updateUserStatus(updateEvent, testUserContext);
        const bodyOfResult = testHelper.standardOkayChecks(resultOfUpdate);
        expect(bodyOfResult).to.deep.equal({ updatedTimeMillis: updateTime });
    });

    it('Update user last full login', async () => {
        const loginTime = moment().valueOf();
        const updateEvent = { loggedInTimeEpochMillis: loginTime };
        updateUserLoginStub.withArgs(testSystemId, loginTime).resolves({ result: 'SUCCESS', lastLoginTimeMillis: loginTime });

        const resultOfUpdate = await handler.updateUserLastLogin(updateEvent, testUserContext);
        const bodyOfResult = testHelper.standardOkayChecks(resultOfUpdate);
        expect(bodyOfResult).to.deep.equal({ lastLoginTimeMillis: loginTime });

        const forbiddenUpdate = await handler.updateUserLastLogin({ systemWideUserId: testSystemId, loggedInTimeEpochMillis: loginTime });
        expect(forbiddenUpdate).to.deep.equal({ statusCode: 403 });
    });

    // todo : also tags, backup phones and backup email once have space to figure out array ops in condition expression
    // todo : validation tests, several
    it('Update user phone and/or email', async () => {
        const forbiddenUpdate = await handler.updateUserDetails({ systemWideUserId: testSystemId, primaryEmail: 'malicious@somewhere.com' });
        expect(forbiddenUpdate).to.deep.equal({ statusCode: 403 });

        const updateTime = moment().valueOf();

        updateUserProfileStub.withArgs(testSystemId, { primaryEmail: 'newemail@newplace.com' }).
            resolves({ result: 'SUCCESS', updatedTimeMillis: updateTime });

        const updateUserEmailEvent = { primaryEmail: 'newemail@newplace.com' };
        const emailUpdateResult = await handler.updateUserDetails(updateUserEmailEvent, testUserContext);
        const bodyOfResult = testHelper.standardOkayChecks(emailUpdateResult);
        expect(bodyOfResult).to.deep.equal({ updatedTimeMillis: updateTime });
        
        updateUserProfileStub.withArgs(testSystemId, { primaryEmail: 'someonehasthis@somewhere.com' }).
            resolves({ result: 'ERROR', message: 'EMAIL_TAKEN' });

        const conflictingUserEmailUpdateEvent = { primaryEmail: 'someonehasthis@somewhere.com' };
        const conflictResult = await handler.updateUserDetails(conflictingUserEmailUpdateEvent, testUserContext);
        expect(conflictResult).to.have.property('statusCode', httpStatusCodeForUserExists);
        expect(conflictResult).to.have.property('body');
        const errorBody = JSON.parse(conflictResult.body);
        expect(errorBody).to.deep.equal({ message: 'A user with that email address already exists', errorType: 'EMAIL_TAKEN', errorField: 'EMAIL_ADDRESS' });
    });

});

