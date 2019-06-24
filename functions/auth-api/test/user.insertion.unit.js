process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:auth:user-insertion-λ-test');
const sinon = require('sinon');
const config = require('config')
const chai = require('chai');
const expect = chai.expect;
const common = require('./common');
const proxyquire = require('proxyquire');
const dynamodb = require('../persistence/dynamodb/dynamodb');

// NB: These tests achieve full coverage on password-update-handler and dynamodb-helper but need to be rewritten
// with some tests being moved to seperate files

let insertStub  = sinon.stub();
let saltVerifierStub = sinon.stub();
let generateJwtStub = sinon.stub();
let loginStub  = sinon.stub();
let dynamodbStub = sinon.stub(dynamodb, 'getPolicy');
let getPolicyStub = dynamodbStub;
let rdsInsertUserCredentialsStub = sinon.stub();
let fetchSingleRowStub = sinon.stub();

const authUtil = proxyquire('../utils/auth-util', {
    '../persistence/dynamodb/dynamodb': {
        getPolicy: getPolicyStub
    }
});

let authUtilPermissionsSpy  = sinon.spy(authUtil, 'assignUserRolesAndPermissions');
let authUtilSignOptionsSpy  = sinon.spy(authUtil, 'getSignOptions');

class MockRdsConnection {
    constructor(any) {
        this.insertRecords = rdsInsertUserCredentialsStub;
    }
};

const rdsUtil = proxyquire('../utils/rds-util', {
    'rds-common': MockRdsConnection,  
    '@noCallThru': true
});

const handler = proxyquire('../user-insertion-handler', {
    './utils/rds-util': rdsUtil, 
    './password-algo': {
        'generateSaltAndVerifier': saltVerifierStub,
        'verifyPassword': loginStub
    },
    './utils/jwt': {
        'generateJsonWebToken': generateJwtStub
    },
    '@noCallThru': true
});

const dynamodbHelper = proxyquire('../persistence/dynamodb/dynamodb', {
    'dynamo-common': {
        'fetchSingleRow': fetchSingleRowStub
    }
});


const mockUserCredentials = rdsUtil.createUserCredentials(
    common.recievedNewUser.systemWideUserId,
    common.recievedNewUser.salt,
    common.recievedNewUser.verifie
);


const resetStubs = () => {
    insertStub.reset();
    saltVerifierStub.reset();
    generateJwtStub.reset();
    loginStub.reset();
    getPolicyStub.reset();
    authUtilPermissionsSpy.restore();
    authUtilSignOptionsSpy.restore();
    rdsInsertUserCredentialsStub.reset();
    fetchSingleRowStub.reset();
};

describe('User insertion', () => {

    before(() => {
        resetStubs();
        saltVerifierStub
            .withArgs(common.recievedNewUser.systemWideUserId, 'greetings')
            .returns({ systemWideUserId: common.recievedNewUser.systemWideUserId, salt: 'andpepper', verifier: 'verified' });
        saltVerifierStub
            .withArgs(null, 'greetings')
            .throws('invalid input')
        rdsInsertUserCredentialsStub // create variable scenarios
            .withArgs(...common.getInsertRecordsArgs(mockUserCredentials)) // userObject; create new tests for rdsUtil
            .resolves({
                command: 'INSERT',
                rowCount: 1,
                oid: 0,
                rows:
                    [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ]
            });
        generateJwtStub.returns('json.web.token');
        getPolicyStub
            .withArgs('defaultUserPolicy', common.recievedNewUser.systemWideUserId)
            .resolves({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "defaultUserPolicy",
                permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            });
        getPolicyStub
            .withArgs('adminUserPolicy', common.recievedNewUser.systemWideUserId)
            .resolves({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "adminUserPolicy",
                permisssions: [
                    "ReadLogs",
                    "ReadPersistenceTables",
                    "CheckBalance",
                    "CheckBalance"
                ]
            });
        getPolicyStub
            .withArgs('supportUserPolicy', common.recievedNewUser.systemWideUserId)
            .resolves({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "supportUserPolicy",
                permissions: [
                    "ReadLogs"
                ]
            });
        fetchSingleRowStub
            .withArgs(config.get('tables.dynamoAuthPoliciesTable'), {policy_id: 'default'})
            .returns({databaseResponse: []});
    });

    context('handler', () => {

        it('should handle new user properly (happy path 1)', async () => {

            const expectedResult = {
                statusCode: 200,
                body: JSON.stringify({
                    jwt: 'json.web.token',
                    message: { 
                        rows: [ { insertion_id: 'an insertion id', creation_time: 'document creation time' }]
                    }
                })
            }
            
            const handlerResponse = await handler.insertUserCredentials(event = { systemWideUserId: common.recievedNewUser.systemWideUserId, password: 'greetings', userRole: 'default'});

            logger('handlerResponse:', handlerResponse);
            logger('rdsInsertUserCredentialsStub called with args:', rdsInsertUserCredentialsStub.getCall(0).args)
            logger('getPolicyStub recieved args:', getPolicyStub.getCall(0).args);
            logger('getPolicyStub returned:', getPolicyStub.getCall(0).returnValue);

            expect(handlerResponse).to.exist;
            expect(handlerResponse).to.deep.equal(expectedResult);
            expect(getPolicyStub).to.have.been.calledOnce;
            expect(handlerResponse).to.have.property('statusCode');
            expect(handlerResponse).to.have.property('body');
            expect(handlerResponse.statusCode).to.deep.equal(200);
            const parsedResult = JSON.parse(handlerResponse.body);
            logger('parsedResult:', parsedResult);
            expect(parsedResult).to.have.property('message');
            expect(parsedResult).to.have.property('jwt');
            expect(parsedResult.jwt).to.not.be.null;
        });


        it('should throw an error on malformed event', async () => {
            expectedResult = {
                statusCode: 500,
                body: JSON.stringify({
                    message: 'some error message'
                })
            };

            const malformedEvent = {
                // missing systemWideUserId
                password: 'user-password'
            };

            const response = await handler.insertUserCredentials(malformedEvent);
            logger('handler response on malformed event:', response);

        })

        it('should persist a new user properly', async () => {
            
            const expectedResult = {databaseResponse: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ]};

            const creationResult = await rdsUtil.insertUserCredentials(mockUserCredentials);
            logger('result of user credentials insertion:', creationResult);

            expect(creationResult).to.exist;
            expect(creationResult).to.deep.equal(expectedResult);
            expect(rdsInsertUserCredentialsStub).to.have.been.calledOnceWithExactly(...common.getInsertRecordsArgs(mockUserCredentials));
        });

        it('should handle user login properly', () => {
            // implement in diffrent test file
        });

    });

    context('authUtil', () => {

        it('should get default user policy and permissions as expected', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "defaultUserPolicy",
                permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'default');
            logger('Result of default user roles and permissions extraction:', result);
            // logger('docClient stub info:', docClientGetStub.getCalls());

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'default');
            expect(getPolicyStub).to.have.been.calledOnceWithExactly('defaultUserPolicy', common.recievedNewUser.systemWideUserId);
        });

        it('should get default user policy and permissions if no role is specified', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "defaultUserPolicy",
                permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId);
            logger('Result of default user roles and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId);
            expect(getPolicyStub).to.have.been.calledOnceWithExactly('defaultUserPolicy', common.recievedNewUser.systemWideUserId);
        })

        it('should get admin policy and permissions as expected when requested by another admin user', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "adminUserPolicy",
                permisssions: [
                    "ReadLogs",
                    "ReadPersistenceTables",
                    "CheckBalance",
                    "CheckBalance"
                ]
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'admin', 'some admin system wide id');
            logger('result of admin user policy and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'admin', 'some admin system wide id');
            expect(getPolicyStub).to.have.been.calledOnceWithExactly('adminUserPolicy', common.recievedNewUser.systemWideUserId);
        });

        it('should get support user policy and permissions as expected when requested by an admin user', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "supportUserPolicy",
                permissions: [
                    "ReadLogs"
                ]
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'support', 'some admin system wide id');
            logger('result of specialised user policy and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'specialised_user', 'some admin system wide id');
            expect(getPolicyStub).to.have.been.calledOnceWithExactly('supportUserPolicy', common.recievedNewUser.systemWideUserId);
        });

        it('should return Undefined Policy when an unsupported policy is requested', () => {
            const expectedResponse = {error: "Undefined Policy"};

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'god');
            logger('result of extraction attempt on nonexistent policy:', result);
            logger(authUtilPermissionsSpy.getCalls())

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResponse);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'god');
            expect(getPolicyStub).to.have.not.been.called;
        })

        it('should throw and error when protected policy and permissions are requested by non-admin user', () => {
            // implement
        });

        it('should get sign options for user', () => {
            const expectedSignOptions = {
                issuer: 'Pluto Saving',
                subject: common.recievedNewUser.systemWideUserId,
                audience: 'https://plutosaving.com'
            };

            const result = authUtil.getSignOptions(common.recievedNewUser.systemWideUserId);
            logger('result of sign options extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedSignOptions);

            expect(authUtilSignOptionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId);
        })
    });

    context('dynamodb helper', () => {

        it('should get user policy from dynamodb', async () => {
            const expectedResult = {databaseResponse: [], systemWideUserId: common.recievedNewUser.systemWideUserId};

            const result = await dynamodbHelper.getPolicy('default', common.recievedNewUser.systemWideUserId);
            logger('result of dynamodb user policy extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(fetchSingleRowStub).to.have.been.calledOnceWithExactly(config.get('tables.dynamoAuthPoliciesTable'), {policy_id: 'default'})
        })
    })
});