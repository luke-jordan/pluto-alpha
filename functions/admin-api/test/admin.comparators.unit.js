'use strict';

const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const checkOtpVerifiedStub = sinon.stub();
const fetchClientFloatVarsStub = sinon.stub();
const updateClientFloatVarsStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-refs-handler', {
    './persistence/dynamo.float': {
        'verifyOtpPassed': checkOtpVerifiedStub,
        'fetchClientFloatVars': fetchClientFloatVarsStub,
        'updateClientFloatVars': updateClientFloatVarsStub        
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

describe('*** UNIT TEST SET REFERENCE RATES FOR FLOAT ***', () => {

    const testUserId = uuid();
    const testClientId = 'some_client';
    const testFloatId = 'primary_mmkt_float';

    beforeEach(() => helper.resetStubs(lamdbaInvokeStub, checkOtpVerifiedStub, updateClientFloatVarsStub));

    it('Unit test setting the bank reference rates', async () => {

        const testReferenceEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            comparatorRates: {
                intervalUnit: 'WHOLE_CURRENCY',
                rateUnit: 'BASIS_POINT',
                rates: {
                    'JPM': {
                        'label': 'JP Morgan Chase',
                        '999': 20,
                        '9999': 50,
                        '99999': 100
                    },
                    'WF': {
                        'label': 'Wells Fargo',
                        '100': 10,
                        '1000': 100,
                        '10000': 110
                    }
                }
            }
        };

        const testInvocation = helper.wrapEvent(testReferenceEvent, testUserId, 'SYSTEM_ADMIN');
        
        const expectedUpdateArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            newComparatorMap: testReferenceEvent.comparatorRates
        };

        checkOtpVerifiedStub.resolves(true);
        updateClientFloatVarsStub.resolves({ result: 'SUCCESS' });

        const testResult = await handler.setFloatReferenceRates(testInvocation);
        expect(testResult).to.exist;
        expect(testResult).to.deep.equal({ statusCode: 200 });
    
        expect(checkOtpVerifiedStub).to.have.been.calledOnceWithExactly(testUserId);
        // expect(fetchClientFloatVarsStub).to.have.been.calledOnce;
        expect(updateClientFloatVarsStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });

    it('Should reject rates that are malformed', async () => {
        const malformedEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            comparatorRates: {
                intervalUnit: 'WHOLE_CURRENCY',
                rateUnit: 'BASIS_POINT',
                rates: {
                    'JPM': {
                        'label': 'JP Morgan',
                        '-10': 2.5
                    }
                }
            }
        };

        const testInvocation = helper.wrapEvent(malformedEvent, testUserId, 'SYSTEM_ADMIN');
        
        const testResult = await handler.setFloatReferenceRates(testInvocation);
        
        expect(testResult).to.exist;
        expect(testResult).to.deep.equal({ statusCode: 400, body: JSON.stringify('Error for JPM, error entries: -10: 2.5') });
        helper.expectNoCalls(checkOtpVerifiedStub, fetchClientFloatVarsStub, updateClientFloatVarsStub);
    });

    it('Should reject unauthorized requests', async () => {
        const badEvent = {
            floatId: testFloatId,
            comparatorRates: {
                'JPM': {
                    '99': 450
                }
            }
        };

        const testInvocation = helper.wrapEvent(badEvent, testUserId, 'ORDINARY_USER');
        const testResult = await handler.setFloatReferenceRates(testInvocation);
        
        expect(testResult).to.exist;
        expect(testResult).to.deep.equal({ 
            headers: helper.expectedHeaders,
            statusCode: 403 
        });
        helper.expectNoCalls(checkOtpVerifiedStub, fetchClientFloatVarsStub, updateClientFloatVarsStub);
    });

    it('Should reject a request without an OTP validation', async () => {
        const irrelevantEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            comparatorRates: {
                intervalUnit: 'WHOLE_CURRENCY',
                rateUnit: 'BASIS_POINT',
                rates: { 
                    'JPM': { }
                }
            }
        };

        const testInvocation = helper.wrapEvent(irrelevantEvent, testUserId, 'SYSTEM_ADMIN');

        checkOtpVerifiedStub.resolves(false);

        const testResult = await handler.setFloatReferenceRates(testInvocation);
        expect(testResult).to.exist;
        expect(testResult).to.deep.equal({ statusCode: 401, body: JSON.stringify({ result: 'OTP_NEEDED' }) });
        
        expect(checkOtpVerifiedStub).to.have.been.calledOnceWithExactly(testUserId);
        helper.expectNoCalls(fetchClientFloatVarsStub, updateClientFloatVarsStub);
    });

});
