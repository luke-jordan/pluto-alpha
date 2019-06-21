process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:auth-user-insertion-λ:test');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const common = require('./common');
const proxyquire = require('proxyquire');
const rdsUtil = require('../utils/rds-util');
const dynamodb = require('../persistence/dynamodb/dynamodb');

// NB: These tests achieve full coverage on password-update-handler but need to be rewritten
// with some tests being moved to seperate files

let insertStub  = sinon.stub();
let saltVerifierStub = sinon.stub();
let generateJwtStub = sinon.stub();
let loginStub  = sinon.stub();
let dynamodbStub = sinon.stub(dynamodb, 'getPolicy');
let getPolicyStub = dynamodbStub;
let rdsInsertUserCredentialsStub = sinon.stub();
let rdsInsertUserCredentialsSpy = sinon.spy(rdsUtil, 'insertUserCredentials');

const authUtil = proxyquire('../utils/auth-util', {
    '../persistence/dynamodb/dynamodb': {
        getPolicy: getPolicyStub
    }
});

let authUtilPermissionsSpy  = sinon.spy(authUtil, 'assignUserRolesAndPermissions');
let authUtilSignOptionsSpy  = sinon.spy(authUtil, 'getSignOptions');

class MockRdsConnection {
    constructor(any) {
        this.insertRecords = insertStub;
    }
};

const rdsConnection = proxyquire('../utils/rds-util', {
    'rds-common': MockRdsConnection,  
    '@noCallThru': true
});

const handler = proxyquire('../user-insertion-handler', {
    './utils/rds-util': {
        'insertUserCredentials': rdsInsertUserCredentialsStub
    }, 
    './password-algo': {
        'generateSaltAndVerifier': saltVerifierStub,
        'verifyPassword': loginStub
    },
    './utils/jwt': {
        'generateJsonWebToken': generateJwtStub
    },
    '@noCallThru': true
});

const resetStubs = () => {
    insertStub.reset();
    saltVerifierStub.reset();
    generateJwtStub.reset();
    loginStub.reset();
    getPolicyStub.reset();
    authUtilPermissionsSpy.restore();
    authUtilSignOptionsSpy.restore();
    rdsInsertUserCredentialsSpy.restore();
    rdsInsertUserCredentialsStub.reset();
    // docClientGetStub.reset();
};

describe('User insertion', () => {

    beforeEach(() => {
        resetStubs();
        saltVerifierStub
            .withArgs(common.recievedNewUser.systemWideUserId, 'greetings')
            .returns({ systemWideUserId: common.recievedNewUser.systemWideUserId, salt: 'andpepper', verifier: 'verified' });
        saltVerifierStub
            .withArgs(null, 'greetings')
            .throws('invalid input')
        rdsInsertUserCredentialsStub // create variable scenarios
            .withArgs() // userObject; create new tests for rdsUtil
            .resolves({
                databaseResponse: { 
                    rows: [ { insertion_id: 'an insertion id', creation_time: 'document creation time' }]
                }
            });
        generateJwtStub.returns('json.web.token');
        getPolicyStub.withArgs('defaultUserPolicy', common.recievedNewUser.systemWideUserId)
            .resolves({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "defaultUserPolicy",
                permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            });
        getPolicyStub.withArgs('adminUserPolicy', common.recievedNewUser.systemWideUserId)
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
        getPolicyStub.withArgs('supportUserPolicy', common.recievedNewUser.systemWideUserId)
            .resolves({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "supportUserPolicy",
                permissions: [
                    "ReadLogs"
                ]
            });
    
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

        it('should persist a new user properly', () => {
            
            const expectedResult = {
                'system_wide_user_id': common.expectedNewUser.system_wide_user_id,
                'salt': common.expectedNewUser.salt,
                'verifier': common.expectedNewUser.verifier,
                'server_ephemeral_secret': common.expectedNewUser.server_ephemeral_secret,
                'created_at': common.expectedNewUser.created_at
            };

            const creationResult = rdsUtil.insertUserCredentials(
                common.recievedNewUser.systemWideUserId,
                common.recievedNewUser.salt,
                common.recievedNewUser.verifier
            );

            expect(creationResult).to.exist;
            expect(creationResult).to.have.keys([
                'sytem_wide_user_id',
                'salt',
                'verifier',
                'server_ephemeral_secret',
                'created_at'
            ]);
            expect(creationResult).to.deep.equal(expectedResult);
            expect(rdsInsertUserCredentialsSpy).to.have.been.calledOnceWithExactly(
                common.recievedNewUser.systemWideUserId,
                common.recievedNewUser.salt,
                common.recievedNewUser.verifier
            );
        });

        it('should handle user login properly', () => {
            // implement in diffrent test file
        });

    });

    context('authUtil', () => {

        beforeEach(() => {
            resetStubs();
        });

        // s3 stub needed on all policy tests
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
            // result matches expectedResponse, however:
            //     authUtilPermissionsSpy is not getting called investigate and patch
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
            // spies dont seem to be getting called, investigate
            expect(authUtilSignOptionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId);
        })
    });

    // context('rdsUtil', () => {

    //     it('should update user password as expected', () => {

    //     })
    // })
});