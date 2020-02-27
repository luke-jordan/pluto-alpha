'use strict';

const logger = require('debug')('jupiter:admin:test');
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
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-user-handler', {
    'publish-common': {
        'publishUserEvent': publishEventStub,
        'sendSystemEmail': sendEmailStub,
        'sendSms': sendSmsStub
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

    beforeEach(() => helper.resetStubs(lamdbaInvokeStub, publishEventStub, sendEmailStub, sendSmsStub));

    const expectedProfile = {
        systemWideUserId: testUserId,
        clientId: 'some_client_co',
        defaultFloatId: 'some_float',
        defaultCurrency: 'USD',
        defaultTimezone: 'America/New_York',
        nationalId: 'some_national_id_here',
        userStatus: 'USER_HAS_SAVED',
        kycStatus: 'VERIFIED_AS_PERSON',
        kycRiskRating: 0,
        securedStatus: 'PASSWORD_SET',
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
                resultPayload: {
                    statusCode: 200,
                    headers: helper.expectedHeaders,
                    body: JSON.stringify(mockPwdBody)
                },
                dispatchResult: { result: 'SUCCESS' }
            }
        })
    };

    it('Updates user password, email route', async () => {
        const mockUserProfile = { ...expectedProfile, contactMethod: 'user@email.com', contactType: 'EMAIL' };

        publishEventStub.resolves({ result: 'SUCCESS' });
        sendEmailStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockPwdLambdaResponse });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockUserProfile) });

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'PWORD',
            reasonToLog: 'Updating user password'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');
        logger('Sending out test event:', testEvent);

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedDispatchResult);

        expect(publishEventStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(sendEmailStub).to.have.been.calledOnceWithExactly({ subject: 'Jupiter Password', toList: ['user@email.com'], templateVariables: { pwd: 'IMPUISSANCE-handsbreadth-190' }});
        expect(sendSmsStub).to.have.not.been.called;
    });

    it('Updates user password, sms route', async () => {
        const mockUserProfile = { ...expectedProfile, contactMethod: '+278132324268', contactType: 'PHONE' };
        const mockDispatchMsg = 'Your password has been successfully reset. Please use the following password to login to your account: IMPUISSANCE-handsbreadth-190. Please create a new password once logged in.';

        publishEventStub.resolves({ result: 'SUCCESS' });
        sendEmailStub.resolves({ result: 'SUCCESS' });
        sendSmsStub.resolves({ result: 'SUCCESS' });
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockPwdLambdaResponse });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockUserProfile) });

        const requestBody = {
            adminUserId: testAdminId,
            systemWideUserId: testUserId,
            fieldToUpdate: 'PWORD',
            reasonToLog: 'Updating user password'
        };

        const testEvent = helper.wrapEvent(requestBody, testUserId, 'SYSTEM_ADMIN');
        logger('Sending out test event:', testEvent);

        const resultOfUpdate = await handler.manageUser(testEvent);
        logger('Result of update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(expectedDispatchResult);
     
        expect(publishEventStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedProfileInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testUserId, includeContactMethod: true }));
        expect(sendSmsStub).to.have.been.calledOnceWithExactly({ phoneNumber: '+278132324268', message: mockDispatchMsg });
        expect(sendEmailStub).to.have.not.been.called;
    });
});
