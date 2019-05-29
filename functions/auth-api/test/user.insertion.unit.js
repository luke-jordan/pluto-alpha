process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:auth:test');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const common = require('./common');
const proxyquire = require('proxyquire');
const uuid = require('uuid/v4');
const rdsUtil = require('../rdsUtil');
const authUtil = require('../authUtil');

let insertStub  = sinon.stub();
let saltVerifierStub = sinon.stub();
let generateJwtStub = sinon.stub();
let loginStub  = sinon.stub();
let authUtilPermissionsSpy  = sinon.spy(authUtil, 'assignUserRolesAndPermissions');
let authUtilSignOptionsSpy  = sinon.spy(authUtil, 'getSignOptions');
let authUtilGetPolicySpy    = sinon.spy(authUtil, 'getPolicy');
let rdsUtilCreateNewUserSpy = sinon.spy(rdsUtil, 'createNewUser');

class MockRdsConnection {
    constructor(any) {
        this.insertRecords = insertStub;
    }
};

const rdsConnection = proxyquire('../rdsUtil', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const handler = proxyquire('../handler', {
    './rdsUtil': rdsConnection, 
    './pwordalgo': {
        'generateSaltAndVerifier': saltVerifierStub,
        'loginExistingUser': loginStub
    },
    './jwt': {
        'generateJSONWebToken': generateJwtStub
    },
    '@noCallThru': true
});

const resetStubs = () => {
    insertStub.reset();
    saltVerifierStub.reset();
    generateJwtStub.reset();
    loginStub.reset();
    authUtilPermissionsSpy.restore();
    authUtilSignOptionsSpy.restore();
    authUtilGetPolicySpy.restore();
    rdsUtilCreateNewUserSpy.restore();
    docClientGetStub.reset();
};

describe('User insertion happy path', () => {

    beforeEach(() => {
        resetStubs();
    });

    afterEach(() => {
        sinon.restore()
    })

    context('handler', () => {

        it('should handle new user properly', async () => {
            const mockUserId = uuid(); // replace with common.expectedSomething.systemWideUserId

            saltVerifierStub.returns({ systemWideUserId: mockUserId, salt: 'andpepper', verifier: 'verified' });
            
            insertStub
                .withArgs(common.expectedInsertionQuery, common.expectedInsertionColumns, common.expectedInsertionList)
                .resolves({
                    databaseResponse: { 
                        rows: [ { insertion_id: 'an insertion id', creation_time: 'document creation time' }]
                    }
                });
            generateJwtStub.returns('some.jwt.token');
            
            const insertionResult = await handler.insertNewUser(event = { systemWideUserId: mockUserId, password: 'hellothere', userRole: 'default'});
            logger('Inserted new user');
            logger('InsertionResult:', insertionResult);
            expect(insertionResult).to.exist;
            expect(insertionResult).to.have.property('statusCode');
            expect(insertionResult).to.have.property('body');
            expect(insertionResult.statusCode).to.deep.equal(200);
            const parsedResult = JSON.parse(insertionResult.body);
            logger('parsedResult:', parsedResult);
            expect(parsedResult).to.have.property('message');
            expect(parsedResult).to.have.property('jwt');
            expect(parsedResult.message).to.have.property('persistedTime');
            expect(parsedResult.jwt).to.not.be.null;
        });

        it('should persist a new user properly', () => {
            
            const expectedResult = {
                'system_wide_user_id': common.expectedNewUser.system_wide_user_id,
                'salt': common.expectedNewUser.salt,
                'verifier': common.expectedNewUser.verifier,
                'server_ephemeral_secret': common.expectedNewUser.server_ephemeral_secret,
                'created_at': common.expectedNewUser.created_at
            };

            const creationResult = rdsUtil.createNewUser(
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
            expect(rdsUtilCreateNewUserSpy).to.have.been.calledOnceWithExactly(
                common.recievedNewUser.systemWideUserId,
                common.recievedNewUser.salt,
                common.recievedNewUser.verifier
            );
        });

        it('should handle user login properly', () => {
            // implement
        });

    });

    context.only('authUtil', () => {

        beforeEach(() => {
            resetStubs();
            docClientGetStub.withArgs({
                TableName: 'roles_and_permissions',
                Key: {
                    policy_id: 'defaultUserPolicy'
                }
            }).returns({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "defaultUserPolicy",
                permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            });
            docClientGetStub.withArgs({
                TableName: 'roles_and_permissions',
                Key: {
                    policy_id: 'adminUserPolicy'
                }
            }).returns({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "adminUserPolicy",
                permisssions: [
                    "ReadLogs",
                    "ReadPersistenceTables",
                    "CheckBalance",
                    "CheckBalance"
                ]
            });
            docClientGetStub.withArgs({
                TableName: 'roles_and_permissions',
                Key: {
                    policy_id: 'supportUserPolicy'
                }
            }).returns({
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "supportUserPolicy",
                permissions: [
                    "ReadLogs"
                ]
            });
        });


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
            logger('docClient stub info:', docClientGetStub.getCalls());

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'default');
            expect(authUtilGetPolicySpy).to.have.been.calledOnceWithExactly('defaultUserPolicy', common.recievedNewUser.systemWideUserId);
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
            expect(authUtilGetPolicySpy).to.have.been.calledOnceWithExactly('defaultUserPolicy', common.recievedNewUser.systemWideUserId);

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
            expect(authUtilGetPolicySpy).to.have.been.calledOnceWithExactly('adminUserPolicy', common.recievedNewUser.systemWideUserId);
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
            expect(authUtilGetPolicySpy).to.have.been.calledOnceWithExactly('supportUserPolicy', common.recievedNewUser.systemWideUserId);
        });

        it('should return Undefined Policy when an unsupported policy is requested', () => {
            const expectedResponse = {error: "Undefined Policy"};

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'god');
            logger('result of extraction attempt on nonexistent policy:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResponse);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'god');
            expect(authUtilGetPolicySpy).to.have.not.been.called;

        })

        it('should throw and error when protected policy and permissions are requested by non-admin user', () => {
            // implement
        });

        it('should get sign options for user', () => {
            const expectedSignOptions = {
                issuer: 'Pluto Savings',
                subject: common.recievedNewUser.systemWideUserId,
                audience: 'https://plutosavings.com'
            };

            const result = authUtil.getSignOptions(common.recievedNewUser.systemWideUserId);
            logger('result of sign options extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedSignOptions);
            expect(authUtilSignOptionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId);
        })
    });

    // context('rdsUtil', () => {

    //     it('should update user password as expected', () => {

    //     })
    // })
});