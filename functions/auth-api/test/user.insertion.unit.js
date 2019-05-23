process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:auth:test');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const common = require('./common');
const proxyquire = require('proxyquire');
const uuid = require('uuid/v4');
const authUtil = require('../authUtil');
const rdsUtil = require('../rdsUtil');

let insertStub = sinon.stub();

class MockRdsConnection {
    constructor(any) {
        this.insertRecords = insertStub;
    }
};

const rdsConnection = proxyquire('../rdsUtil', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

let saltVerifierStub = sinon.stub();
let generateJwtStub = sinon.stub();
let loginStub = sinon.stub();
let authUtilPermissionsSpy = sinon.spy(authUtil, 'assignUserRolesAndPermissions');
let authUtilSignOptionsSpy = sinon.spy(authUtil, 'getSignOptions');
let rdsUtilCreateNewUserSpy = sinon.spy(rdsUtil, 'createNewUser');

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
    loginStub.reset();
    authUtilPermissionsSpy.restore();
    authUtilSignOptionsSpy.restore();
    rdsUtilCreateNewUserSpy.restore();
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
            const mockUserId = uuid();

            saltVerifierStub.returns({ systemWideUserId: mockUserId, salt: 'andpepper', verifier: 'verified' });
            insertStub.resolves({databaseResponse: { insertion_id: 'an insertion id'}}); // here art lies our trouble
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
            expect(parsedResult.message).to.have.property('insertion_id');
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

        it('should handle user login propertly', () => {
            // implement
        });

    });

    context('authUtil', () => {

        it('should get default user roles and permissions as expected', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "Default User Role",
                Permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'default');
            logger('Result of default user roles and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'default');
        });

        it('should get default user roles and permissions if no role is specified', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "Default User Role",
                Permissions: [
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

        })

        it('should get admin roles and permissions as expected when requested by another admin user', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "Admin Role",
                Permisssions: [
                    "ReadLogs",
                    "ReadPersistenceTables",
                    "CheckBalance"
                ]
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'admin', 'some admin system wide id');
            logger('result of admin user roles and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'admin', 'some admin system wide id');
        });

        it('should get specialised user roles and permissions as expected when requested by an admin user', () => {
            const expectedRolesAndPermissions = {
                systemWideUserId: common.recievedNewUser.systemWideUserId,
                role: "Specialised User Role",
                Permissions: []
            };

            const result = authUtil.assignUserRolesAndPermissions(common.recievedNewUser.systemWideUserId, 'specialised_user', 'some admin system wide id');
            logger('result of specialised user roles and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedRolesAndPermissions);
            expect(authUtilPermissionsSpy).to.have.been.calledOnceWithExactly(common.recievedNewUser.systemWideUserId, 'specialised_user', 'some admin system wide id')
        })

        it('should throw and error when protected roles and permissions are requested by non-admin user', () => {
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
});