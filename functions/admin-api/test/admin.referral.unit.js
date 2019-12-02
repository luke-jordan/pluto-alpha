'use strict';

const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const lambdaInvokeStub = sinon.stub();
const findCountryStub = sinon.stub();
const listRefCodesStub = sinon.stub();
const putAdminLogStub = sinon.stub();
const verifyOtpStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../admin-refs-handler', {
    './persistence/dynamo.float': {
        'findCountryForClientFloat': findCountryStub,
        'listReferralCodes': listRefCodesStub,
        'putAdminLog': putAdminLogStub,
        'verifyOtpPassed': verifyOtpStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    }
});

describe('*** UNIT TEST RETRIEVING AND TRANSFORMING REFERRAL CODES ***', () => {

    const testAdminId = uuid();

    const testClientId = 'some_client';
    const testFloatId = 'primary_mmkt_float';
    const testBonusPoolId = 'principal_bonus_pool';

    const testRefCode = 'LETMEIN';

    beforeEach(() => {
        helper.resetStubs(lambdaInvokeStub, listRefCodesStub, putAdminLogStub, findCountryStub);
        verifyOtpStub.resolves(true);
    });

    it('Should invoke create referral code with correct arguments', async () => {
        const testPersistedTime = moment();

        const testInboundEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            referralCode: testRefCode,
            codeType: 'CHANNEL',
            bonusSource: testBonusPoolId,
            bonusAmount: {
                amount: 0,
                unit: 'HUNDREDTH_CENT',
                currency: 'USD'
            },
            tags: ['Something']
        };

        const expectedInvocation = {
            referralCode: testRefCode,
            codeType: 'CHANNEL',
            creatingUserId: testAdminId,
            floatId: testFloatId,
            clientId: testClientId,
            countryCode: 'RWA',
            referralContext: {
                boostAmountOffered: '0::HUNDREDTH_CENT::USD',
                bonusPoolId: testBonusPoolId
            }
        };

        findCountryStub.resolves('RWA');
        lambdaInvokeStub.returns({ promise: () => helper.mockLambdaDirect({ persistedTimeMillis: testPersistedTime.valueOf() })});
        listRefCodesStub.resolves([{ referralCode: testRefCode }]); // not the point here, so quick stub

        const apiGwEvent = helper.wrapPathEvent(testInboundEvent, testAdminId, 'create');
        const resultOfReferralCreation = await handler.manageReferralCodes(apiGwEvent);

        helper.standardOkayChecks(resultOfReferralCreation, true);

        const expectedResult = { result: 'SUCCESS', persistedTimeMillis: testPersistedTime.valueOf(), updatedCodes: [{ referralCode: testRefCode }] };
        expect(expectedResult).to.deep.equal(JSON.parse(resultOfReferralCreation.body));

        expect(findCountryStub).to.have.been.calledWith(testClientId, testFloatId);
        
        const expectedLambdaInvoke = helper.wrapLambdaInvoc(config.get('lambdas.createReferralCode'), false, expectedInvocation);
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);
        
        expect(listRefCodesStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(putAdminLogStub).to.have.been.calledOnceWithExactly(testAdminId, 'REFERRAL_CODE_CREATED', testInboundEvent);
    });

    // it('Handles errors in code creation, e.g., duplicates', async () => {
    // });

    it('Should retrieve and compose list of referral codes', async () => {
        const apiGwEvent = helper.wrapQueryParamEvent({ clientId: testClientId, floatId: testFloatId }, testAdminId, 'SYSTEM_ADMIN');
        apiGwEvent.pathParameters = { proxy: 'list' };
        
        const expectedCode = ['ALPHA', 'BRAVO'].map((code) => ({
            referralCode: code,
            countryCode: 'RWA',
            clientId: testClientId,
            floatId: testFloatId,
            codeType: 'CHANNEL',
            bonusAmount: {
                amount: Math.floor(Math.random() * 1000000),
                unit: 'HUNDREDTH_CENT',
                currency: 'USD'
            },
            bonusSource: 'some_bonus_pool',
            tags: ['ALPHA']
        }));

        listRefCodesStub.resolves(expectedCode);
                
        const resultOfReferralList = await handler.manageReferralCodes(apiGwEvent);

        helper.standardOkayChecks(resultOfReferralList, true);

        expect(listRefCodesStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
    });

    it.skip('Should deactivate a referral code', async () => {
        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            code: testRefCode,
            reasonToLog: 'Outlived its usefulness'
        };

        const expectedPayload = {
            referralCode: testRefCode,
            clientId: testClientId,
            floatId: testFloatId,
            operation: 'DEACTIVATE',
            initiator: testAdminId
        };

        const apiGwEvent = helper.wrapEvent(testEvent, testAdminId, 'deactivate');
        const resultOfDeactivation = await handler.manageReferralCodes(apiGwEvent);

        helper.standardOkayChecks(resultOfDeactivation);
        expect(resultOfDeactivation.body).to.equal(JSON.stringify({ result: 'DEACTIVATED' }));

        const expectedLambdaInvoke = helper.wrapLambdaInvoc(config.get('lambdas.modifyReferralCode'), false, expectedPayload);
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);

        expect(putAdminLogStub).to.have.been.calledOnceWithExactly(testAdminId, 'REFERRAL_CODE_DEACTIVATED', testEvent);
    });

    it.skip('Should modify a referral code', async () => {
        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            referralCode: testRefCode,
            amount: 1000000,
            bonusSource: 'test_bonus_pool',
            tags: ['Added'],
            reasonToLog: 'Giving people some motivation'
        };

        const expectedPayload = {
            referralCode: testRefCode,
            clientId: testClientId,
            floatId: testFloatId,
            operation: 'UPDATE',
            initiator: testAdminId,
            newContext: {

            }
        };

        const apiGwEvent = helper.wrapEvent(testEvent, testAdminId, 'modify');
        const resultOfModification = await handler.manageReferralCodes(apiGwEvent);

        helper.standardOkayChecks(resultOfModification);
        expect(resultOfModification.body).to.equal(JSON.stringify({ result: 'UPDATED' }));

        const expectedLambdaInvoke = helper.wrapLambdaInvoc(config.get('lambdas.modifyReferralCode'), false, expectedPayload);
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedLambdaInvoke);

        expect(putAdminLogStub).to.have.been.calledOnceWithExactly(testAdminId, 'REFERRAL_CODE_MODIFIED', testEvent);
    });

    it.skip('Should accurately validate if a referral code is available', async () => {
        const eventBase = { clientId: testClientId, floatId: testFloatId };

        const availableTest = { ...eventBase, referralCode: 'AVAILABLE' };
        const availableInvoke = helper.wrapLambdaInvoc(config.get('lambdas.verifyReferralCode'), false, availableTest);
        lambdaInvokeStub.withArgs(availableInvoke).returns({ promise: () => helper.mockLambdaResponse({ result: 'CODE_NOT_FOUND' }, 404) });

        const unavailableTest = { ...eventBase, referralCode: 'UNAVAILABLE' };
        const unavailableInvoke = helper.wrapLambdaInvoc(config.get('lambdas.verifyReferralCode'), false, unavailableTest);
        lambdaInvokeStub.withArgs(unavailableInvoke).returns({ promise: () => helper.mockLambdaResponse({ result: 'CODE_IS_ACTIVE' }, 200)});
        

        const availableApiGwEvent = helper.wrapQueryParamEvent(availableTest, testAdminId);
        availableApiGwEvent.pathParameters = { proxy: 'available' };
        
        const resultOfValidation = await handler.manageReferralCodes(availableApiGwEvent);
        expect(resultOfValidation).to.deep.equal({ statusCode: 200 });

        const unavailableApiGwEvent = helper.wrapQueryParamEvent(unavailableTest, testAdminId);
        unavailableApiGwEvent.pathParameters = { proxy: 'available' };
        const resultOfSecond = await handler.manageReferralCodes(unavailableApiGwEvent);
        expect(resultOfSecond).to.deep.equal({ statusCode: 409 });
    });

    // it('Should reject an unauthorized request', async () => {
    //     const apiGwEvent = helper.wrapQueryParamEvent({ clientId: testClientId, floatId: testFloatId }, testAdminId);
    // });

    // it('Should reject a malformed request', async () => {

    // });

});
