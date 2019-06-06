'use strict';

const logger = require('debug')('pluto:lambda-authorizer:test');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const common = require('./common');
const chai = require('chai');
const expect = chai.expect;

const requestStub = sinon.stub();

const authorizer = proxyquire('../basicLambdaAuthorizer/handler', {
    'request-promise': requestStub,
    '@noCallThru': true
});

const mockEventCallback = (err, generatedPolicy) => {
    if (err) {
        logger('about to return ERR', {message: err}); 
        return {message: err};
    }
    logger('event callback about to return', generatedPolicy)
    return generatedPolicy;
};

describe('basicLambdaAuthorizer', () => {
    
    beforeEach(() => {
        requestStub
            .withArgs(common.getStubArgs('validTokenToLambdaAuthorizer'))
            .resolves(common.expectedRequestPromiseResponseOnValidToken);
        requestStub
            .withArgs(common.getStubArgs('invalidTokenToLambdaAuthorizer'))
            .resolves(common.expectedRequestPromiseResponseOnInvalidToken);
    });


    context('handler', () => {

        it('should verify valid token', async () => {
            const expectedResult = common.expectedAuthorizationResponseOnValidToken;

            const mockEvent = {
                type: "TOKEN",
                authorizationToken: 'Bearer a_valid.auth.token',
                methodArn: "arn"
            };
            
            const result = await authorizer.basicLambdaAuthorizer(mockEvent, 'eventContextGoesHere', mockEventCallback);
            logger('Got this back from lamda authorizer on valid token:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(requestStub).to.have.been.calledOnceWithExactly(common.getStubArgs('validTokenToLambdaAuthorizer'));
        });

        it('should return Unauthorized on invalid token', async () => {
            const expectedResult = "Unauthorized";

            const mockEvent = {
                type: "TOKEN",
                authorizationToken: 'Bearer an_invalid.auth.token',
                methodArn: "arn"
            };

            const result = await authorizer.basicLambdaAuthorizer(mockEvent, 'eventContextGoesHere', mockEventCallback);
            logger('Got this back from lambda authorizer on invalid token', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
            expect(requestStub).to.have.been.calledOnceWithExactly(common.getStubArgs('invalidTokenToLambdaAuthorizer'));
        });

        it('should create correct IAM policy', () => {
            const expectedResult = common.expectedAuthorizationResponseOnValidToken;

            const result = authorizer.generatePolicy(
                'a-system-wide-user-id',
                'Allow',
                'arn',
                { 
                    systemWideUserId: 'a-system-wide-user-id',
                    role: 'Default User Role',
                    permissions: [ 'EditProfile', 'CreateWallet', 'CheckBalance' ] 
                }
            );
            logger('Got this back from policy generation:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
        });

        it('should extract user role and permissions from decoded token', () => {
            const expectedResult = { 
                systemWideUserId: 'a-system-wide-user-id',
                role: 'Default User Role',
                permissions: [ 'EditProfile', 'CreateWallet', 'CheckBalance' ] 
            };

            const mockDecodedToken = common.expectedRequestPromiseResponseOnValidToken.decoded;

            const result = authorizer.getRolesAndPermissions(mockDecodedToken);
            logger('got this back from role and permissions extraction:', result);

            expect(result).to.exist;
            expect(result).to.deep.equal(expectedResult);
        });
    })
});