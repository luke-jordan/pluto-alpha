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
let derivePrivateKeyStub = sinon.stub();
let deriveVerifierStub = sinon.stub();
let generateEphemeralStub = sinon.stub();
let deriveSessionStub = sinon.stub();
let verifySessionStub = sinon.stub();
let getSaltAndServerPublicEphemeralStub = sinon.stub();
let getServerSessionProofStub = sinon.stub();

const passwordAlgorithm = proxyquire('../password-algo', {
    'secure-remote-password/client': {
        'generateSalt': generateSaltStub,
        'derivePrivateKey': derivePrivateKeyStub,
        'deriveVerifier': deriveVerifierStub,
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
    derivePrivateKeyStub.reset();
    deriveVerifierStub.reset();
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

    context("User sign up (credentials insertion)", () => {

        before(() => {
            resetStubs();
            generateSaltStub.returns('andpepper');
            derivePrivateKeyStub.withArgs('andpepper', expectedArgsForSignup.systemWideUserId, expectedArgsForSignup.password).returns('some-private-key');
            deriveVerifierStub.withArgs('some-private-key').returns('pushit');
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
            expect(derivePrivateKeyStub).to.be.calledOnceWithExactly('andpepper', expectedArgsForSignup.systemWideUserId, expectedArgsForSignup.password);
            expect(deriveVerifierStub).to.be.calledOnceWithExactly('some-private-key');
        });

        it('should return error on invalid input arguments', () => {
            const expectedResult = {error: 'Invalid input'};

            const result = passwordAlgorithm.generateSaltAndVerifier(passedInSignUpDetails.systemWideUserId);
            logger('result of invalid input to user registration:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(generateSaltStub).to.not.have.been.called;
            expect(derivePrivateKeyStub).to.not.have.been.called;
            expect(deriveVerifierStub).to.not.have.been.called;
        })
    });


    context('User Login (credentials verification)', () => {

        beforeEach(() => {
            resetStubs();
            generateEphemeralStub.withArgs('mock persisted verifier').returns('a verifier-encoded ephemeral public key');
            generateEphemeralStub.returns({secret: 'mock client secret ephemeral', public: 'mock client public ephemeral'});
            derivePrivateKeyStub
                .withArgs('and-pepper', expectedLoginDetails.systemWideUserId, expectedLoginDetails.password)
                .returns('mock client private key');
            derivePrivateKeyStub
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
                .resolves(JSON.stringify({serverSessionProof: 'serverSession.proof'}));
            getSaltAndServerPublicEphemeralStub
                .withArgs()
                .resolves(JSON.stringify({
                    salt: 'and-pepper',
                    serverPublicEphemeral: 'mock server public ephemeral'
                }));
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
            logger('derivePrivateKey call details:', derivePrivateKeyStub.getCall(0).args)

            expect(result).to.exist;
            expect(result).to.have.keys(['systemWideUserId', 'verified']);
            expect(result).to.deep.equal(expectedLoginResult)
            expect(generateEphemeralStub).to.have.been.calledOnceWithExactly();
            expect(derivePrivateKeyStub).to.have.been.calledOnceWithExactly('and-pepper', expectedLoginDetails.systemWideUserId, expectedLoginDetails.password);
            expect(deriveSessionStub).to.have.been.calledOnceWithExactly(
                'mock client secret ephemeral',
                'mock server public ephemeral',
                'and-pepper',
                expectedLoginDetails.systemWideUserId,
                'mock client private key'
            );
        });

        it('password verifier should throw error on invalid arguments', async () => {
            const expectedfirstResultand3 = {
                systemWideUserId: null,
                verified: false, 
                reason: 'Invalid arguments passed to verifyPassword()' 
            }

            const expectedsecondResult = { 
                systemWideUserId: expectedLoginDetails.systemWideUserId,
                verified: false, 
                reason: 'Invalid arguments passed to verifyPassword()' 
            };

            const firstResult = await passwordAlgorithm.verifyPassword(null, null);
            const secondResult = await passwordAlgorithm.verifyPassword(passedInLoginDetails.systemWideUserId, null);
            const thirdResult = await passwordAlgorithm.verifyPassword(null, passedInLoginDetails.password);
            logger('result of password verifier call with null arguments:', firstResult);
            logger('result of password verifier call with missing password:', secondResult);
            logger('result of password verifier call with missing user id:', thirdResult);

            expect(firstResult).to.deep.equal(expectedfirstResultand3);
            expect(secondResult).to.deep.equal(expectedsecondResult);
            expect(thirdResult).to.deep.equal(expectedfirstResultand3);
            expect(generateEphemeralStub).to.have.not.been.called;
            expect(getSaltAndServerPublicEphemeralStub).to.have.not.been.called;
            expect(derivePrivateKeyStub).to.have.not.been.called;
            expect(deriveSessionStub).to.have.not.been.called;
            expect(getServerSessionProofStub).to.have.not.been.called;
            expect(verifySessionStub).to.have.not.been.called;
        });

        it('should throw and error on salt and server public ephemeral extraction failure', async () => {
            // TODO
        });

        it('should throw an error on server session proof extraction failure', async () => {
            // TODO
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