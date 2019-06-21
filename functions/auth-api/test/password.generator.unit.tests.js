'use strict';

const logger = require('debug')('pluto:alpha:password-generator-lambda-test');
const common = require('./common');
const uuid = require('uuid/v4');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
const expect = chai.expect;


const rdsUpdateUserStub = sinon.stub();
const verifyPasswordStub = sinon.stub();
const generateSaltAndVerifierStub = sinon.stub();
const insertUserCredentialsStub = sinon.stub();
const updateServerEphemeralSecretStub = sinon.stub();
const getUserCredentialsStub = sinon.stub();
const passwordGeneratorStub = sinon.stub();
const requestStub = sinon.stub();
// s3 related stub


// TODO: add more rds related stubs
const handler = proxyquire('../password-generation-handler', {
    'request-promise': requestStub,
    'niceware': passwordGeneratorStub,
    './utils/rds-util': {
        updateUserSaltAndVerifier: rdsUpdateUserStub,
        insertUserCredentials: insertUserCredentialsStub,
        updateServerEphemeralSecret: updateServerEphemeralSecretStub,
        getUserCredentials: getUserCredentialsStub
    },
    './password-algo': {
        verifyPassword: verifyPasswordStub,
        generateSaltAndVerifier: generateSaltAndVerifierStub
    },
    '@noCallThru': true
});

const notifyAdminsSpy = sinon.spy(handler, 'notifyAdministrators');

const resetStubs = () => {
    rdsUpdateUserStub.reset();
    verifyPasswordStub.reset();
    generateSaltAndVerifierStub.reset();
    passwordGeneratorStub.reset();
    requestStub.reset();
};

const mockEvent = {
    systemWideUserId: uuid(),
    token: 'test.auth.token', // really sore for more properties
};


class adminContactObject {
    constructor() {
        this.systemWideUserId = uuid();
        this.rolesAndPermissions = {};
        this.contactDetails = {
            phone: '000000000',
            email: 'admin@plutosaving.com'
        }
    }
};


const adminOne = new adminContactObject();
const adminTwo = new adminContactObject();
const adminThree = new adminContactObject();


describe('Password Generator Lambda', () => {
    
    context('lambda routine', () => {

        beforeEach(() => {
            resetStubs();
            verifyPasswordStub.withArgs().returns();
            generateSaltAndVerifierStub.withArgs().returns();
            rdsUpdateUserStub.withArgs().returns();
            passwordGeneratorStub.withArgs().returns('soma_prism_ungentle');
        });
 
        it('lambda handler should return generated password and admin notification details', async () => {
            const expectedResult = common.expectedPasswordGenerationHandlerResponse;

            const result = await handler.geerateEphemeralPassword(mockEvent);
            logger('result of ephemeral password generation', result);

            expect(result).to.exist;
            expect(result).to.have.keys(['statusCode', 'body']);
            expect(result.statusCode).to.deep.equal(200);
            const body = JSON.parse(result.body);
            expect(body).to.exist;
            expect(body).to.deep.equal(expectedResult);
            expect(generateSaltAndVerifierStub).to.have.been.calledOnceWithExactly();
            expect(rdsUpdateUserStub).to.have.been.calledOnceWithExactly(); // TODO
            expect(passwordGeneratorStub).to.have.been.calledOnceWithExactly(); // TODO
            expect(requestStub).to.have.been.calledOnceWithExactly(); // TODO
            expect(notifyAdminsSpy).to.have.been.calledOnceWithExactly(); // TODO
        });


        it('should generate new password', () => {
            const expectedResult = 'soma_prism_ungentle';

            const result = handler.genneratePassword();
            logger('result of password generartion:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(passwordGeneratorStub).to.have.been.calledOnceWithExactly();
        });

        it('should persist encrypted new password', async () => {
            const expetedResult = common.passwordUpdateResponseOnSuccess().message;

            const result = await  handler.persistSaltAndVerifier(mockEvent.systemWideUserId, 'new-pepper', 'new-gerated-password-verifier');
            logger('persisting new salt and verifier returned', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expetedResult);
            expect(rdsUpdateUserStub).to.have.been.calledOnceWithExactly(mockEvent.systemWideUserId, 'new-pepper', 'new-generated-password-verifier');
        });

        it('should fetch admin contact details from s3', async () => {
            const expectedResult = [adminOne, adminTwo, adminThree];

            const result = await handler.fetchAdministators();
            logger('got the following from admin contact details extraction:', );

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            // expect some s3 related stub o have been called with certain arguments;
        });

        it('should notify admin of password change', async () => {
            const expectedResult = null;

            const updateMessage = '';
            const result = handler.notifyAdmin(adminOne, updateMessage);
            logger('got this back from admin notification of user password update:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(requestStub).to.have.been.calledOnceWithExactly(); // TODO
        });
    });
});