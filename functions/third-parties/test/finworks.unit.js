'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify-test');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const requestStub = sinon.stub();
const getObjectStub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub; 
    }
}

const handler = proxyquire('../finworks-handler', {
    'aws-sdk': { 'S3': MockS3Client },
    'request-promise': requestStub
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST FINWORKS ENDPOINTS ***', () => {

    const expectedHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    beforeEach(() => {
        resetStubs(requestStub, getObjectStub);
    });
    
    it('Registers user account with FinWorks', async () => {
        const testNationalId = '1234566789';

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ accountNumber: 'POL23' });

        const testEvent = {
            idNumber: testNationalId,
            surname: 'Fei',
            firstNames: 'Han'
        };

        const resultOfRegistration = await handler.createAccount(testEvent);
        logger('Result of FinWorks account creation:', resultOfRegistration);

        expect(resultOfRegistration.statusCode).to.deep.equal(200);
        expect(resultOfRegistration.headers).to.deep.equal(expectedHeaders);
        expect(resultOfRegistration.body).to.deep.equal(JSON.stringify({ accountNumber: 'POL23' }));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnce;
    });

    it('Sends investment details', async () => {
        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ });

        const testEvent = {
            accountNumber: 'POL23',
            amount: '100',
            unit: 'WHOLE_CURRENCY',
            currency: 'USD'
        };

        const resultOfInvestement = await handler.addCash(testEvent);
        logger('Investment result from third party:', resultOfInvestement);

        expect(resultOfInvestement.statusCode).to.deep.equal(200);
        expect(resultOfInvestement.headers).to.deep.equal(expectedHeaders);
        expect(resultOfInvestement.body).to.deep.equal(JSON.stringify({ }));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnce;
    });
});
