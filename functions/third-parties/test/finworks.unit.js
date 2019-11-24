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
        const testFirstName = 'Han';
        const testLastName = 'Fei';
        const testEndpoint = 'https://fwtest.jupitersave.com/api/accounts/createPersonAndAccount';

        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true,
            body: { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ accountNumber: 'POL23' });

        const testEvent = { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName };

        const resultOfRegistration = await handler.createAccount(testEvent);
        logger('Result of FinWorks account creation:', resultOfRegistration);

        expect(resultOfRegistration.statusCode).to.deep.equal(200);
        expect(resultOfRegistration.headers).to.deep.equal(expectedHeaders);
        expect(resultOfRegistration.body).to.deep.equal(JSON.stringify({ accountNumber: 'POL23' }));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Cathes error during account creation', async () => {
        const testNationalId = '1234566789';
        const testFirstName = 'Han';
        const testLastName = 'Fei Zi';
        const testEndpoint = 'https://fwtest.jupitersave.com/api/accounts/createPersonAndAccount';

        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true,
            body: { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.throws(new Error('Negative contact'));

        const testEvent = { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName };

        const resultOfRegistration = await handler.createAccount(testEvent);
        logger('Result of FinWorks account creation on error:', resultOfRegistration);

        expect(resultOfRegistration.statusCode).to.deep.equal(500);
        expect(resultOfRegistration.headers).to.deep.equal(expectedHeaders);
        expect(resultOfRegistration.body).to.deep.equal(JSON.stringify('Negative contact'));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Sends investment details', async () => {
        const testAccountNumber = 'POL23';
        const [testAmount, testUnit, testCurrency] = '100::WHOLE_CURRENCY::USD'.split('::');
        const testEndpoint = `https://fwtest.jupitersave.com/api/accounts/${testAccountNumber}/investments`;

        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true,
            body: { amount: testAmount, unit: testUnit, currency: testCurrency }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ });

        const testEvent = { accountNumber: testAccountNumber, amount: testAmount, unit: testUnit, currency: testCurrency };

        const resultOfInvestement = await handler.addCash(testEvent);
        logger('Investment result from third party:', resultOfInvestement);

        expect(resultOfInvestement.statusCode).to.deep.equal(200);
        expect(resultOfInvestement.headers).to.deep.equal(expectedHeaders);
        expect(resultOfInvestement.body).to.deep.equal(JSON.stringify({ }));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Cathes add cash error', async () => {
        const testAccountNumber = 'POL23';
        const [testAmount, testUnit, testCurrency] = '100::WHOLE_CURRENCY::USD'.split('::');
        const testEndpoint = `https://fwtest.jupitersave.com/api/accounts/${testAccountNumber}/investments`;
        
        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true,
            body: { amount: testAmount, unit: testUnit, currency: testCurrency }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.throws(new Error('Negative contact'));

        const testEvent = { accountNumber: testAccountNumber, amount: testAmount, unit: testUnit, currency: testCurrency };

        const resultOfInvestement = await handler.addCash(testEvent);
        logger('Investment result from third party:', resultOfInvestement);

        expect(resultOfInvestement.statusCode).to.deep.equal(500);
        expect(resultOfInvestement.headers).to.deep.equal(expectedHeaders);
        expect(resultOfInvestement.body).to.deep.equal(JSON.stringify('Negative contact'));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Fetches user market value', async () => {
        const testAccountNumber = 'POL122';
        const testEndpoint = `https://fwtest.jupitersave.com/api/accounts/${testAccountNumber}/marketValue`

        const expectedOptions = {
            method: 'GET',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ 'amount' : '599.9900', 'currency' : 'ZAR' });

        const testEvent = { accountNumber: 'POL122' };

        const accountMarketValue = await handler.getMarketValue(testEvent);
        logger('Result of market value extraction:', accountMarketValue);

        expect(accountMarketValue.statusCode).to.deep.equal(200);
        expect(accountMarketValue.headers).to.deep.equal(expectedHeaders);
        expect(accountMarketValue.body).to.deep.equal(JSON.stringify({ 'amount' : '599.9900', 'currency' : 'ZAR' }));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Catches market value errors', async () => {
        const testAccountNumber = 'POL122';
        const testEndpoint = `https://fwtest.jupitersave.com/api/accounts/${testAccountNumber}/marketValue`

        const expectedOptions = {
            method: 'GET',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.throws(new Error('Negative contact'));

        const testEvent = { accountNumber: testAccountNumber };

        const accountMarketValue = await handler.getMarketValue(testEvent);
        logger('Result of market value extraction:', accountMarketValue);

        expect(accountMarketValue.statusCode).to.deep.equal(500);
        expect(accountMarketValue.headers).to.deep.equal(expectedHeaders);
        expect(accountMarketValue.body).to.deep.equal(JSON.stringify('Negative contact'));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Sends user withdrawal to third party', async () => {
        const expectedOptions = {
            method: 'POST',
            uri: 'https://fwtest.jupitersave.com/api/accounts/POL122/withdrawals',
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true,
            body: {
                amount: 1234.56,
                currency: 'ZAR',
                bankDetails: {
                    holderName: 'John Doe',
                    accountNumber: 'POL122',
                    branchCode: '222626',
                    type: 'Savings',
                    bankName: 'FNB'
                }
            }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 201 });

        const testEvent = {
            amount : 1234.56,
            currency: 'ZAR',
            holderName: 'John Doe',
            accountNumber: 'POL122',
            branchCode: '222626',
            type: 'Savings',
            bankName: 'FNB'
        };

        const resultOfTransmission = await handler.sendWithdrawal(testEvent);
        logger('Investment result from third party:', resultOfTransmission);

        expect(resultOfTransmission.statusCode).to.deep.equal(200);
        expect(resultOfTransmission.headers).to.deep.equal(expectedHeaders);
        expect(resultOfTransmission.body).to.deep.equal(JSON.stringify({ statusCode: 201 }));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Catches withdrawal transmission errors', async () => {
        const expectedOptions = {
            method: 'POST',
            uri: 'https://fwtest.jupitersave.com/api/accounts/POL122/withdrawals',
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            json: true,
            body: {
                amount: 1234.56,
                currency: 'ZAR',
                bankDetails: {
                    holderName: 'John Doe',
                    accountNumber: 'POL122',
                    branchCode: '222626',
                    type: 'Savings',
                    bankName: 'FNB'
                }
            }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.throws(new Error('Negative contact'));

        const testEvent = {
            amount : 1234.56,
            currency: 'ZAR',
            holderName: 'John Doe',
            accountNumber: 'POL122',
            branchCode: '222626',
            type: 'Savings',
            bankName: 'FNB'
        };

        const resultOfTransmission = await handler.sendWithdrawal(testEvent);
        logger('Investment result from third party:', resultOfTransmission);

        expect(resultOfTransmission.statusCode).to.deep.equal(500);
        expect(resultOfTransmission.headers).to.deep.equal(expectedHeaders);
        expect(resultOfTransmission.body).to.deep.equal(JSON.stringify('Negative contact'));
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

});
