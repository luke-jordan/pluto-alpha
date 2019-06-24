'use strict';

const logger = require('debug')('pluto:auth:password-update-λ-test')
const common = require('./common');
const sinon = require('sinon');
const chai = require('chai');
const uuid = require('uuid/v4')
const expect = chai.expect;
const proxyquire = require('proxyquire');

const rdsUpdateUserSaltAndVerifierStub = sinon.stub();
const verifyPasswordStub = sinon.stub();
const generateSaltAndVerifierStub = sinon.stub();

const handler = proxyquire('../password-update-handler', {
    './utils/rds-util': {
        updateUserSaltAndVerifier: rdsUpdateUserSaltAndVerifierStub,
    },
    './password-algo': {
        verifyPassword: verifyPasswordStub,
        generateSaltAndVerifier: generateSaltAndVerifierStub
    },
    '@noCallThru': true
});

const resetStubs = () => {
    rdsUpdateUserSaltAndVerifierStub.reset();
    verifyPasswordStub.reset();
    generateSaltAndVerifierStub.reset();
};

const mockSystemWideUserId = uuid();


describe('Password Change/Reset', () => {

    context('Password Reset', () => {

        beforeEach(() => {
            resetStubs();
            rdsUpdateUserSaltAndVerifierStub
                .withArgs(mockSystemWideUserId, 'new-pepper', 'new-generated-password-verifier')
                .returns({statusCode: 0, message: {rows: [{ insertion_id: 'an insertion id', updated_time: 'document update time' }]}});
            rdsUpdateUserSaltAndVerifierStub
                .withArgs(mockSystemWideUserId, 'new-pepper-on-fAiling-persIstence', 'new-generated-password-verifier')
                .returns({statusCode: 1, message: 'An error occured during database update attempt.'});
            verifyPasswordStub
                .withArgs(mockSystemWideUserId, 'valid-old-passw0rd')
                .returns({ systemWideUserId: mockSystemWideUserId, verified: true });
            verifyPasswordStub
                .withArgs(mockSystemWideUserId, 'invalid-old-passw0rd')
                .returns({systemWideUserId: mockSystemWideUserId, verified: false, reason: 'Invalid old password'});                
            generateSaltAndVerifierStub
                .withArgs(mockSystemWideUserId, 'new-passw0rd')
                .returns({salt: 'new-pepper', verifier: 'new-generated-password-verifier'});
            generateSaltAndVerifierStub
                .withArgs(mockSystemWideUserId, 'new-passw0rd-to-fAiling-persIstence')
                .returns({salt: 'new-pepper-on-fAiling-persIstence', verifier: 'new-generated-password-verifier'});
        });


        it('should update persisted user credentials object with new salt and verifier' /*and increment number in password_changes column*/, async () => {

            const mockEvent = {
                oldPassword: 'valid-old-passw0rd',
                newPassword: 'new-passw0rd',
                systemWideUserId: mockSystemWideUserId,
            };

            const expectedResult = common.passwordUpdateResponseOnSuccess(mockEvent);

            const result = await handler.updatePassword(mockEvent);
            logger('result of password update with valid old password', result);
            logger('verifyPasswordStub called with args', verifyPasswordStub.getCall(0).args);
            logger('rdsUpdateUserSaltAndVerifierStub called with:', rdsUpdateUserSaltAndVerifierStub.getCall(0).args);
            
            expect(result).to.exist;
            expect(result.statusCode).to.deep.equal(200);
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.deep.equal(expectedResult);
            expect(verifyPasswordStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, mockEvent.oldPassword);
            expect(generateSaltAndVerifierStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, mockEvent.newPassword);
            expect(rdsUpdateUserSaltAndVerifierStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, 'new-pepper', 'new-generated-password-verifier');
        });

        it('should return an error on invalid old password', async () => {

            const mockEvent = {
                oldPassword: 'invalid-old-passw0rd',
                newPassword: 'new-passw0rd',          
                systemWideUserId: mockSystemWideUserId,
            };

            const expectedResult = common.passwordUpdateResponseOnBadOldPassword(mockEvent);

            const result = await handler.updatePassword(mockEvent);
            logger('result of password update with invalid old password', result);
            logger('verifyPasswordStub called with args', verifyPasswordStub.getCall(0).args);

            expect(result).to.exist;
            expect(result.statusCode).to.deep.equal(500);
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.deep.equal(expectedResult);
            expect(verifyPasswordStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, mockEvent.oldPassword);
            expect(generateSaltAndVerifierStub).to.have.not.been.called;
            expect(rdsUpdateUserSaltAndVerifierStub).to.have.not.been.called;
        });

        it('should return an error on persistence failure', async () => {

            const mockEvent = {
                oldPassword: 'valid-old-passw0rd',
                newPassword: 'new-passw0rd-to-fAiling-persIstence',
                systemWideUserId: mockSystemWideUserId,
            };

            const expectedResult = common.passwordUpdateResponseOnPersistenceFailure(mockEvent);

            const result = await handler.updatePassword(mockEvent);
            logger('result of password update on troublesome persistence operation', result);
            logger('verifyPasswordStub called with args', verifyPasswordStub.getCall(0).args);
            logger('rdsUpdateUserSaltAndVerifierStub called with:', rdsUpdateUserSaltAndVerifierStub.getCall(0).args)

            expect(result).to.exist;
            expect(result.statusCode).to.deep.equal(500);
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.deep.equal(expectedResult);
            expect(verifyPasswordStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, mockEvent.oldPassword);
            expect(generateSaltAndVerifierStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, mockEvent.newPassword);
            expect(rdsUpdateUserSaltAndVerifierStub).to.have.been.calledOnceWithExactly(mockSystemWideUserId, 'new-pepper-on-fAiling-persIstence', 'new-generated-password-verifier')
        });
    });

    context('Password Reset', () => {
        // this context may be moved to a seperate test file, as an intermediary lambda may be used to generate a memorable password and add
        // details of the event origin. On success this intermediary lambda then notifies the user and the administrator? of the new password.
        // On first login with this new password the user will be required to choose a new password.

        it('should generate new memorable password', () => {
     
        });
    });
});