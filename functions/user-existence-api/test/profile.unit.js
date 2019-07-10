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

const proxyquire = require('proxyquire').noCallThru();

const insertUserProfileStub = sinon.stub();
const updateUserProfileStub = sinon.stub();


// tables: UserProfileTable, NationalIdUserTable, EmailUserTable, PhoneUserTable

const fetchUserBySystemIdStub = sinon.stub();
const fetchUserByIdStub = sinon.stub();
const fetchUserByPhoneStub = sinon.stub();
const fetchUserByEmailStub = sinon.stub();

const fetchStubs = [fetchUserBySystemIdStub, fetchUserByIdStub, fetchUserByPhoneStub, fetchUserByEmailStub];
const dynamoStubs = {
    'insertUserProfile': insertUserProfileStub,
    'updateUserProfile': updateUserProfileStub,
    'fetchUserBySystemId': fetchUserBySystemIdStub,
    'fetchUserById': fetchUserByIdStub,
    'fetchUserByPhone': fetchUserByPhoneStub,
    'fetchUserByEmail': fetchUserByEmailStub
};

const handler = proxyquire('../profile.handler', {
    './persistence/dynamo': dynamoStubs
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

describe('*** UNIT TEST USER PROFILE *** FINDING USERS ***', () => {

    const testReturnedUser = {
        systemId: testSystemId,
        clientId: testClientId,
        nationalId: testNationalId,
        primaryPhone: testPhone,
        primaryEmail: testeEmail,
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
        expect(retrievedUser).to.deep.equal({ systemWideId: testSystemId, clientId: testClientId, nationalId: testNationalId });
    });

    // note: will want to rate limit all of these (and/or the login lambda that sits in front of it)
    it('Successfully find a user by their primary email', async () => {
        fetchUserByEmailStub.withArgs(testEmail).resolves(testSystemId);
        const fetchUserProjection = await handler.fetchUserByPersonalDetail({ emailAddress: testEmail }); // will have to rate limit
        const retrievedUser = testHelper.standardOkayChecks(fetchUserProjection);
        expect(retrievedUser).to.deep.equal({ systemWideId: testSystemId, emailAddress: testEmail });
    });

    it('Successfully find a user by their primary phone', async () => {
        fetchUserByPhoneStub.withArgs(testPhone).resolves(testSystemId);
        const fetchUserProjection = await handler.fetchUserByPersonalDetail({ phoneNumber: testPhone });
        const retrievedUser = testHelper.standardOkayChecks(fetchUserProjection);
        expect(retrievedUser).to.deep.equal({ systemWideId: testSystemId, phoneNumber: testPhone });
    });

    it('Successfully find a user by their system wide user ID', () => {
        const userResult = await handler.fetchUserBySystemId({ }, testUserContext);
        const retrievedUser = testHelper.standardOkayChecks(userResult);
        expect(retrievedUser).to.deep.equal(testReturnedUser);

        const adminResult = await handler.fetchUserBySystemId({ systemWideId: testSystemId }, testAdminContext);
        const retreivedByAdmin = testHelper.standardOkayChecks(adminResult);
        expect(retreivedByAdmin).to.deep.equal(testReturnedUser);
    });

    it('Gracefully handle user not found', () => {
        
    });

    it('Throw error if no context, if not user calling, or if not system admin', () => {

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

    before(() => {
        testHelper.resetStubs(Object.values(dynamoStubs));
        insertUserProfileStub.withArgs(wellFormedRequest).returns(wellFormedRequest); // or, what else does Dynamo put in? Also a timestamp?
    });
    
    beforeEach(() => {
        testHelper.resetStubs(fetchStubs);
        testHelper.resetStubs([insertUserProfileStub]);
    });

    afterEach(() => {
        testHelper.expectNoCalls(updateUserProfileStub);
    });

    it('Insert a new user profile, happy path, ID and phone number', () => {
        fetchUserByIdStub.withArgs(testClientId, testNationalId).resolves({ });
        fetchUserByPhoneStub.withArgs(testPhone).resolves({ });
        const resultOfInsert = await handler.insertNewUser(wellFormedRequest);
        const insertBody = testHelper.standardOkayChecks(resultOfInsert);
        // ... okay, then the rest.
    });

    it('Fail if any part of user data is not unique', () => {

    });

});


describe('*** UNIT TEST USER PROFILE *** UPDATING USERS ***', () => {

    it('Update a user status', () => {

    });

    it('Update a user KYC status', () => {

    });

    it('Update user secured status', () => {

    });

    it('Update user role', () => {

    });

    it('Update user last full login', () => {

    });

    it('Update user tags', () => {

    });

    it('Update user primary phone', () => {

    });

    it('Update user email', () => {

    });

});

