'use strict';

// const logger = require('debug')('jupiter:admin:test');
const config = require('config');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test.helper');

const momentStub = sinon.stub();
const sendSmsStub = sinon.stub();
const sendEmailStub = sinon.stub();
const publishEventStub = sinon.stub();
const lambdaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../admin-user-manage', {
    'publish-common': {
        'publishUserEvent': publishEventStub,
        'sendSystemEmail': sendEmailStub,
        'sendSms': sendSmsStub,
        '@noCallThru': true
    },
    './persistence/rds.account': {
        '@noCallThru': true
    },
    './admin.util': {},
    'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

describe('*** UNIT TEST ADMIN PASSWORD RESET ***', () => {
    const testAdminId = uuid();
    const testUserId = uuid();

    beforeEach(() => helper.resetStubs(lambdaInvokeStub, publishEventStub, sendEmailStub, sendSmsStub));

    const expectedProfile = {
        systemWideUserId: testUserId,
        userRole: 'ORDINARY_USER',
        tags: 'GRANTED_GIFT'
    };

    const expectedProfileInvocation = helper.wrapLambdaInvoc(config.get('lambdas.passwordUpdate'), false, {
        generateRandom: true,
        requestContext: {
            authorizer: {
                role: 'SYSTEM_ADMIN',
                systemWideUserId: testUserId
            }
        },
        systemWideUserId: testUserId
    });
    
    const mockPwdBody = {
        result: 'SUCCESS',
        newPassword: 'IMPUISSANCE-handsbreadth-190',
        message: 'Note: this password is auto-generated and must be noted down now'
    };

    const mockPwdLambdaResponse = {
        StatusCode: 200,
        Payload: JSON.stringify({
            statusCode: 200,
            headers: helper.expectedHeaders,
            body: JSON.stringify(mockPwdBody)
        })
    };

    const expectedDispatchResult = {
        statusCode: 200,
        headers: helper.expectedHeaders,
        body: JSON.stringify({
            result: 'SUCCESS',
            updateLog: {
                dispatchResult: { result: 'SUCCESS' }
            }
        })
    };

    it('Updates user password, email route', async () => {
        const mockUserProfile = { ...expectedProfile, emailAddress: 'user@email.com' };

        const expectedEmailArgs = {
            subject: 'Jupiter Password',
            toList: ['user@email.com'],
            bodyTemplateKey: config.get('email.pwdReset.templateKey'),
            templateVariables: { pwd: 'IMPUISSANCE-handsbreadth-190' }
        };

        publishEventStub.resolves({ result: 'SUCCESS' });
        sendEmailStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockPwdLambdaResponse });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockUserProfile) });

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'PWORD',
            reasonToLog: 'Updating user password'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedDispatchResult);

        expect(publishEventStub).to.have.been.calledOnce;
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWith(expectedProfileInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(sendEmailStub).to.have.been.calledOnceWithExactly(expectedEmailArgs);
        expect(sendSmsStub).to.have.not.been.called;
    });

    it('Updates user password, sms route', async () => {
        const mockUserProfile = { ...expectedProfile, phoneNumber: '278132324268' };
        const mockDispatchMsg = 'Your password has been successfully reset. Please use the following password to login to your account: IMPUISSANCE-handsbreadth-190. Please create a new password once logged in.';

        publishEventStub.resolves({ result: 'SUCCESS' });
        sendEmailStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });
        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockPwdLambdaResponse });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockUserProfile) });

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'PWORD',
            reasonToLog: 'Updating user password'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.manageUser(testEvent);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedDispatchResult);
     
        expect(publishEventStub).to.have.been.calledOnce;
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWith(expectedProfileInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(sendSmsStub).to.have.been.calledOnceWithExactly({ phoneNumber: '+278132324268', message: mockDispatchMsg });
        expect(sendEmailStub).to.have.not.been.called;
    });
});
