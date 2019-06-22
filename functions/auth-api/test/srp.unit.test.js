'use strict';

const logger = require('debug')('pluto:auth:password-algo-test');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const uuid = require('uuid/v4');
const common = require('./common');

const proxyquire = require('proxyquire');

let generateSaltStub = sinon.stub();
let privateKeyStub = sinon.stub();
let verifierStub = sinon.stub();
let generateEphemeralStub = sinon.stub();
let deriveSessionStub = sinon.stub();
let verifySessionStub = sinon.stub();
let getSaltAndServerPublicEphemeralStub = sinon.stub();
let getServerSessionProofStub = sinon.stub();

const passwordAlgorithm = proxyquire('../password-algo', {
    'secure-remote-password/client': {
        'generateSalt': generateSaltStub,
        'derivePrivateKey': privateKeyStub,
        'deriveVerifier': verifierStub,
        'generateEphemeral': generateEphemeralStub,
        'deriveSession': deriveSessionStub,
        'verifySession': verifySessionStub
    },
    './user-verification-helper': {
        'getSaltAndServerPublicEphemeral': getSaltAndServerPublicEphemeralStub,
        'getServerSessionProof': getServerSessionProofStub
    }
});

const resetStubs = () => {
    generateSaltStub.reset();
    privateKeyStub.reset();
    verifierStub.reset();
    generateEphemeralStub.reset();
    deriveSessionStub.reset();
    verifySessionStub.reset();
};

const passedInSignUpDetails = {
    systemWideUserId: uuid(),
    password: 'a password policy compliant password'
};

const expectedArgsForSignup = {
    systemWideUserId: passedInSignUpDetails.systemWideUserId,
    password: passedInSignUpDetails.password
};

const passedInLoginDetails = {
    systemWideUserId: uuid(),
    password: 'a password policy compliant password'
}
const expectedLoginDetails = {
    systemWideUserId: passedInLoginDetails.systemWideUserId,
    password: passedInLoginDetails.password
};


describe('SecureRemotePassword', () => {

    context("User sign up", () => {

        before(() => {
            resetStubs();
            generateSaltStub.returns('andpepper');
            privateKeyStub.withArgs('andpepper', expectedArgsForSignup.systemWideUserId, expectedArgsForSignup.password).returns('some-private-key');
            verifierStub.withArgs('some-private-key').returns('pushit');
        });

        it('should return username, salt and verifier', () => {
            const expectedResult = { 
                systemWideUserId: expectedArgsForSignup.systemWideUserId, 
                salt: 'andpepper', 
                verifier: 'pushit' 
            };
            
            const result = passwordAlgorithm.generateSaltAndVerifier(passedInSignUpDetails.systemWideUserId, passedInSignUpDetails.password);
            logger('result of signup: ', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(generateSaltStub).to.be.calledOnceWithExactly();
            expect(privateKeyStub).to.be.calledOnceWithExactly('andpepper', expectedArgsForSignup.systemWideUserId, expectedArgsForSignup.password);
            expect(verifierStub).to.be.calledOnceWithExactly('some-private-key');
        });

        it('should return error on invalid input arguments', () => {
            const expectedResult = {error: 'Invalid input'};

            const result = passwordAlgorithm.generateSaltAndVerifier(passedInSignUpDetails.systemWideUserId);
            logger('result of invalid input to user registration:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(generateSaltStub).to.not.have.been.called;
            expect(privateKeyStub).to.not.have.been.called;
            expect(verifierStub).to.not.have.been.called;
        })
    });


    context('User Login', () => {

        beforeEach(() => {
            resetStubs();
            generateEphemeralStub.withArgs('mock persisted verifier').returns('a verifier-encoded ephemeral public key');
            generateEphemeralStub.returns({secret: 'mock client secret ephemeral', public: 'mock client public ephemeral'});
            privateKeyStub
                .withArgs('andpepper', expectedLoginDetails.systemWideUserId, expectedLoginDetails.password)
                .returns('mock client private key');
            privateKeyStub
                .withArgs('andpepper', 'mock system-wide user id to unavailable server', expectedLoginDetails.password)
                .returns('mock client private key');
            deriveSessionStub
                .withArgs(...common.getStubArgs('deriveClientSession', expectedLoginDetails.systemWideUserId))
                .returns({proof: 'mock client session proof'});
            deriveSessionStub
                .withArgs(...common.getStubArgs('deriveServerSession', expectedLoginDetails.systemWideUserId))
                .returns({proof: 'mock server session proof'});
            deriveSessionStub
                .withArgs(...common.getStubArgs('deriveSessionOnNonResponsiveServer'))
                .returns({proof: 'mock client session proof'});
            getServerSessionProofStub
                .withArgs()
                .resolves({serverSessionProof: 'serverSession.proof'});
            getSaltAndServerPublicEphemeralStub
                .withArgs()
                .resolves({
                    salt: 'and-pepper',
                    serverPublicEphemeral: 'serverPublicEphemeralKey'
                });
            verifySessionStub
                .returns({ systemWideUserId: passedInLoginDetails.systemWideUserId, verified: true });
            }
        );


        it("should verify user credentials during login", async () => {
            const expectedLoginResult = {
                systemWideUserId: expectedLoginDetails.systemWideUserId,
                verified: true
            };

            const result = await passwordAlgorithm.verifyPassword(passedInLoginDetails.systemWideUserId, passedInLoginDetails.password);
            logger('result of login:', result);

            expect(result).to.exist;
            expect(result).to.have.keys(['systemWideUserId', 'verified']);
            expect(result).to.deep.equal(expectedLoginResult)
            expect(generateEphemeralStub).to.have.been.calledOnceWithExactly();
            expect(privateKeyStub).to.have.been.calledOnceWithExactly('andpepper', expectedLoginDetails.systemWideUserId, expectedLoginDetails.password);
            expect(deriveSessionStub).to.have.been.calledOnceWithExactly(
                'mock client secret ephemeral',
                'mock server public ephemeral',
                'andpepper',
                expectedLoginDetails.systemWideUserId,
                'mock client private key'
            );
        });

        it('should get salt and server public ephemeral key', () => {
            const expectedServerResult = {
                salt: 'some rds stub returned salt',
                serverPublicEphemeral: 'a verifier encoded ephemeral public key',
            };
            
            const serverResult = passwordAlgorithm.getSaltAndServerPublicEphemeral(expectedLoginDetails.systemWideUserId, 'the clients public ephemeral key');
            logger('result of salt and server publick ephemeral key extraction:', serverResult);

            expect(serverResult).to.exist;
            expect(serverResult).to.have.keys(['salt', 'serverPublicEphemeral']);
            expect(serverResult).to.deep.equal(expectedServerResult);
            expect(generateEphemeralStub).to.have.been.calledOnceWithExactly('persisted verifier');
        });

        it('should get server session proof', () => {
            const expectedServerResponse = {
                serverSessionProof: 'mock server session proof'
            };

            const serverResponse = passwordAlgorithm.getServerSessionProof(
                expectedLoginDetails.systemWideUserId,
                'mock client session proof',
                'mock client public ephemeral'
            );

            logger('server session proof:', serverResponse);

            expect(serverResponse).to.exist;
            expect(serverResponse).to.have.keys(['serverSessionProof']);
            expect(serverResponse).to.deep.equal(expectedServerResponse);
            expect(deriveSessionStub).to.have.been.calledOnceWithExactly(
                'mock server ephemeral secret',
                'mock client public ephemeral',
                'andpepper',
                expectedLoginDetails.systemWideUserId,
                'mock persisted verifier',
                'mock client session proof'
            );
        });

        it('should gracefully handle null response from unavailable verification server 1', () => {
            const expectedServerResponse = {
                systemWideUserId: 'mock system-wide user id to unavailable server 1',
                verified: false, 
                reason: 'No response from server'
            };

            const serverResponse = passwordAlgorithm.verifyPassword(
                'mock system-wide user id to unavailable server 1',
                expectedLoginDetails.password
            );
            logger('result drom unavailble server 1:', serverResponse);

            expect(serverResponse).to.exist;
            expect(serverResponse).to.deep.equal(expectedServerResponse);
            expect(loginHelperStub).to.have.been.calledWith(
                'saltAndServerPublicEphemeralLambdaUrl', {
                    systemWideUserId: 'mock system-wide user id to unavailable server 1',
                    clientPublicEphemeral: 'mock client public ephemeral'
            });
        }); 

        it('should gracefully handle null response from unavailable verification server 2', () => {
            const expectedServerResponse = {
                systemWideUserId: 'mock system-wide user id to unavailable server', 
                verified: false, 
                reason: 'Server session proof not recieved'
            }

            const serverResponse = passwordAlgorithm.verifyPassword(
                'mock system-wide user id to unavailable server',
                expectedLoginDetails.password
            );

            logger('result from unavailable server 2:', serverResponse);

            expect(serverResponse).to.exist;
            expect(serverResponse).to.deep.equal(expectedServerResponse);
            expect(loginHelperStub).to.have.been.calledWith(
                'saltAndServerPublicEphemeralLambdaUrl', {
                    systemWideUserId: 'mock system-wide user id to unavailable server',
                    clientPublicEphemeral: 'mock client public ephemeral'
            });
            expect(loginHelperStub).to.have.been.calledWith(
                'serverSessionProofLambdaUrl', {
                    systemWideUserId: 'mock system-wide user id to unavailable server',
                    clientSessionProof: 'mock client session proof',
                    clientPublicEphemeral: 'mock client public ephemeral'
            });
        });
    });
});