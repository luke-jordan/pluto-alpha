'use strict';

const logger = require('debug')('pluto:auth-password-reset-λ:main')
const common = require('./common');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');

const rdsUpdateUserStub = sinon.stub();
const verifyPasswordStub = sinon.stub();
const generateSaltAndVerifierStub = sinon.stub();

const handler = proxyquire('../password-reset-lambda/handler', {
    '../utils/rds-util': rdsUpdateUserStub,
    '../user-insertion-lambda/password-algo': {
        verifyPassword: verifyPasswordStub,
        generateSaltAndVerifier: generateSaltAndVerifierStub
    },
    '@noCallThru': true
});

const resetStubs = () => {
    rdsUpdateUserStub.reset();
    verifyPasswordStub.reset();
    generateSaltAndVerifierStub.reset();
}


describe.only('Password Change/Reset', () => {

    context('Password Reset', () => {

        beforeEach(() => {
            resetStubs();
            rdsUpdateUserStub.withArgs().returns();
            verifyPasswordStub.withArgs().returns();
            generateSaltAndVerifierStub.withArgs().returns();
        });


        it('should update persisted user credentials object with new salt and verifier' /*and increment number in password_changes column*/, () => {

            const mockEvent = {
                oldPassword: 'valid-old-passw0rd',
                newPassword: 'new-passw0rd',
                origin: {
                    systemWideUserId: 'a-system-wide-user-id',
                    otherDetails: []
                }
            };

            const expectedResult = common.passwordUpdateResponseOnSuccess(mockEvent);

            const result = handler.updatePassword(mockEvent);
            logger('result of password update with valid old password');

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(verifyPasswordStub).to.have.been.calledOnceWithExactly(mockEvent.origin.systemWideUserId, mockEvent.oldPassword);
            expect(generateSaltAndVerifierStub).to.have.been.calledOnceWithExactly(mockEvent.origin.systemWideUserId, mockEvent.newPassword);
            expect(rdsUpdateUserStub).to.have.been.calledOnceWithExactly() // TODO
        });

        it('should return an error on invalid old password', () => {

            const mockEvent = {
                oldPassword: 'invalid-old-passw0rd',
                newPassword: 'new-passw0rd',
                origin: {
                    systemWideUserId: 'a-system-wide-user-id',
                    otherDetails: []
                }
            };

            const expectedResult = common.passwordUpdateResponseOnBadOldPassword(mockEvent);

            const result = handler.updatePassword(mockEvent);
            logger('result of password update with invalid old password');

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(verifyPasswordStub).to.have.been.calledOnceWithExactly(mockEvent.origin.systemWideUserId, mockEvent.oldPassword);
            expect(generateSaltAndVerifierStub).to.have.not.been.called;
            expect(rdsUpdateUserStub).to.have.not.been.called;
        });

        it('should return an error on persistence failure', () => {

            const mockEvent = {
                oldPassword: 'valid-or-invalid-old-passw0rd',
                newPassword: 'new-passw0rd',
                origin: {
                    systemWideUserId: 'a-system-wide-user-id',
                    otherDetails: []
                }
            };

            const expectedResult = common.passwordUpdateResponseOnPersistenceFailure(mockEvent);

            const result = handler.updatePassword(mockEvent);
            logger('result of password update with valid old password');

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(verifyPasswordStub).to.have.been.calledOnceWithExactly(mockEvent.origin.systemWideUserId, mockEvent.oldPassword);
            expect(generateSaltAndVerifierStub).to.have.been.calledOnceWithExactly(mockEvent.origin.systemWideUserId, mockEvent.newPassword);
            expect(rdsUpdateUserStub).to.have.been.calledOnceWithExactly() // TODO
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