'use strict';

const logger = require('debug')('pluto:alpha:user-verification-unit-tests');
const sinon = require('sinon');
const uuid = require('uuid/v4');
const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');


const generateEphemeralStub = sinon.stub();
const deriveSessionStub = sinon.stub();
const updateServerEphemeralSecretStub = sinon.stub();
const getUserCredentialsStub = sinon.stub();


const verificationHelper = proxyquire('../user-verification-helper', {
    'secure-remote-password/server': {
        'generateEphemeral': generateEphemeralStub,
        'deriveSession': deriveSessionStub
    },
    './utils/rds-util': {
        'updateServerEphemeralSecret': updateServerEphemeralSecretStub,
        'getUserCredentials': getUserCredentialsStub
    }
});

const mockSystemWideUserId = uuid();
const mockSystemWideUserId2 = uuid();
const mockSystemWideUserId3 = uuid();
const mockServerSessionProof = uuid();
const mockClientSessionProof = uuid();
const mockClientPublicEphemeral = uuid();
const mockServerEphemeralSecret = uuid();
const mockServerPublicEphemeral = uuid();
const mockPersistedSalt = uuid();
const mockPersistedVerifier = uuid();

const resetStubs = () => {
    generateEphemeralStub.reset();
    deriveSessionStub.reset();
    updateServerEphemeralSecretStub.reset();
    getUserCredentialsStub.reset();
};



describe('User Credentials Verification', () => {


    context('user verification handler', () => {
        beforeEach(() => {

        })

        it('should properly verify valid user credentials', async () => {

        });

        it('should properly verify invalid user credentials', async () => {

        });

    });


    context('User verification helper', () => {

        beforeEach(() => {
            resetStubs();
            getUserCredentialsStub
                .withArgs(mockSystemWideUserId)
                .returns([{
                    salt: mockPersistedSalt,
                    verifier: mockPersistedVerifier
                }]);
            getUserCredentialsStub
                .withArgs(mockSystemWideUserId2)
                .returns([{
                    salt: mockPersistedSalt,
                    verifier: mockPersistedVerifier,
                    server_ephemeral_secret: mockServerEphemeralSecret
                }]);
            getUserCredentialsStub
                .withArgs(mockSystemWideUserId3)
                .returns({error: 'error'});
            updateServerEphemeralSecretStub
                .withArgs(mockSystemWideUserId, mockServerEphemeralSecret)
                .returns({
                    command: 'UPDATE',
                    rowCount: 1,
                    oid: null,
                    rows:
                        [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ]
                });
            deriveSessionStub
                .withArgs(mockServerEphemeralSecret,
                    mockClientPublicEphemeral,
                    mockPersistedSalt,
                    mockSystemWideUserId2,
                    mockPersistedVerifier,
                    mockClientSessionProof)
                .returns({proof: mockServerSessionProof});
            generateEphemeralStub
                .withArgs(mockPersistedVerifier)
                .returns({
                    secret: mockServerEphemeralSecret,
                    public: mockServerPublicEphemeral
                });
        });

        it('should get persisted salt and server public ephemeral key', async () => {
            const expectedResult = {
                salt: mockPersistedSalt,
                serverPublicEphemeral: mockServerPublicEphemeral
            };

            const result = await verificationHelper.getSaltAndServerPublicEphemeral(mockSystemWideUserId);
            logger('result and salt and server public ephemeral extraction:', result);

            expect(result).to.exist;
            const parsedResult = JSON.parse(result);
            expect(parsedResult).to.deep.equal(expectedResult);
            expect(getUserCredentialsStub).to.have.been.calledOnceWithExactly(mockSystemWideUserId);
            expect(updateServerEphemeralSecretStub).to.have.been.calledOnceWithExactly(
                mockSystemWideUserId,
                mockServerEphemeralSecret
            );
        });

        it('should get persisted server session proof', async () => {
            const expectedResult = { serverSessionProof: mockServerSessionProof };

            const result = await verificationHelper.getServerSessionProof(mockSystemWideUserId2, mockClientSessionProof, mockClientPublicEphemeral);
            logger('result of server session proof extraction: ', result);

            expect(result).to.exist;
            const parsedResult = JSON.parse(result);
            expect(parsedResult).to.deep.equal(expectedResult);
            expect(getUserCredentialsStub).to.have.have.been.calledOnceWithExactly(mockSystemWideUserId2);
            expect(deriveSessionStub).to.have.been.calledOnceWithExactly(
                mockServerEphemeralSecret,
                mockClientPublicEphemeral,
                mockPersistedSalt,
                mockSystemWideUserId2,
                mockPersistedVerifier,
                mockClientSessionProof
            );
        });

        it('should throw an error on failure during salt server public ephemeral extraction', async () => {
            const expectedResult = {
                salt: null,
                serverPublicEphemeral: null,
                reason: 'error' // more verbose errors are thrown by the actual function
            };

            const result = await verificationHelper.getSaltAndServerPublicEphemeral(mockSystemWideUserId3);
            logger('result of failing salt and server public ephemeral extraction:', result);

            expect(result).to.exist;
            const parsedResult = JSON.parse(result);
            expect(parsedResult).to.deep.equal(expectedResult);
        });

        it('should throw an error on failure during server session proof extraction', async () => {
            const expectedResult = {
                serverSessionProof: null,
                reason: 'error'
            };

            const result = await verificationHelper.getServerSessionProof(mockSystemWideUserId3, mockClientSessionProof, mockClientPublicEphemeral);
            logger('result of failing server session proof extraction:', result);

            expect(result).to.exist;
            const parsedResult = JSON.parse(result);
            expect(parsedResult).to.deep.equal(expectedResult);
        });
    });
});