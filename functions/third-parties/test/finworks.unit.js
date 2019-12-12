'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify-test');
const config = require('config');
const util = require('util');

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

    beforeEach(() => {
        resetStubs(requestStub, getObjectStub);
    });
    
    it('Registers user account with FinWorks', async () => {
        const testNationalId = '1234566789';
        const testFirstName = 'Han';
        const testLastName = 'Fei';
        const testEndpoint = `${config.get('finworks.endpoints.rootUrl')}${config.get('finworks.endpoints.accountCreation')}`;

        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 200, body: { accountNumber: 'POL23' }});

        const testEvent = { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName };

        const resultOfRegistration = await handler.createAccount(testEvent);
        logger('Result of FinWorks account creation:', resultOfRegistration);

        expect(resultOfRegistration).to.exist;
        expect(resultOfRegistration).to.deep.equal({ accountNumber: 'POL23' });
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Cathes error during account creation', async () => {
        const testNationalId = '1234566789';
        const testFirstName = 'Han';
        const testLastName = 'Fei Zi';
        const testEndpoint = `${config.get('finworks.endpoints.rootUrl')}${config.get('finworks.endpoints.accountCreation')}`;

        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({
            statusCode: 400,
            body: {
                errors: [{
                    description: 'A person matching the idNumber already exists',
                    code: 'ExistingPersonWithIDNumberFound'
                }]
            }
        });

        const testEvent = { idNumber: testNationalId, surname: testLastName, firstNames: testFirstName };

        const resultOfRegistration = await handler.createAccount(testEvent);
        logger('Result of FinWorks account creation on error:', resultOfRegistration);

        expect(resultOfRegistration).to.exist;
        expect(resultOfRegistration).to.have.property('result', 'ERROR');
        expect(resultOfRegistration).to.have.property('details');
        const parsedError = JSON.parse(resultOfRegistration.details);
        expect(parsedError).to.have.property('errors');
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Sends investment details', async () => {
        const testAccountNumber = 'POL23';
        const [testAmount, testUnit, testCurrency] = '100::WHOLE_CURRENCY::USD'.split('::');
        const testEndpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.addCash'), testAccountNumber)}`;

        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: { amount: testAmount, unit: testUnit, currency: testCurrency }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 201, body: { } });

        const testEvent = { accountNumber: testAccountNumber, amount: testAmount, unit: testUnit, currency: testCurrency };

        const resultOfInvestement = await handler.addCash(testEvent);
        logger('Investment result from third party:', resultOfInvestement);

        expect(resultOfInvestement).to.exist;
        expect(resultOfInvestement).to.deep.equal({ });
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Cathes add cash error', async () => {
        const testAccountNumber = 'POL23';
        const [testAmount, testUnit, testCurrency] = '100::WHOLE_CURRENCY::USD'.split('::');
        const testEndpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.addCash'), testAccountNumber)}`;
        
        const expectedOptions = {
            method: 'POST',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: { amount: testAmount, unit: testUnit, currency: testCurrency }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({
            statusCode: 400,
            body: {
                errors: [{
                    description: 'Account is inactive',
                    code: 'AccountInactiveError'
                }]
            }
        });

        const testEvent = { accountNumber: testAccountNumber, amount: testAmount, unit: testUnit, currency: testCurrency };

        const resultOfInvestement = await handler.addCash(testEvent);
        logger('Investment result from third party:', resultOfInvestement);

        expect(resultOfInvestement).to.exist;
        expect(resultOfInvestement).to.have.property('result', 'ERROR');
        expect(resultOfInvestement).to.have.property('details');
        const parsedError = JSON.parse(resultOfInvestement.details);
        expect(parsedError).to.have.deep.equal({ errors: [{ description: 'Account is inactive', code: 'AccountInactiveError' }]});
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Fetches user market value', async () => {
        const testAccountNumber = 'POL122';
        const testEndpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.marketValue'), testAccountNumber)}`;

        const expectedOptions = {
            method: 'GET',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 200, body: { amount: '599.9900', currency: 'ZAR' }});

        const testEvent = { accountNumber: 'POL122' };

        const accountMarketValue = await handler.getMarketValue(testEvent);
        logger('Result of market value extraction:', accountMarketValue);

        expect(accountMarketValue).to.exist;
        expect(accountMarketValue).to.deep.equal({ amount: '599.9900', currency: 'ZAR' });
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Catches market value errors', async () => {
        const testAccountNumber = 'POL122';
        const testEndpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.marketValue'), testAccountNumber)}`;

        const expectedOptions = {
            method: 'GET',
            uri: testEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({
            statusCode: 400,
            body: {
                errors: [{
                    description: 'Account is inactive',
                    code: 'AccountInactiveError'
                }]
            }
        });

        const testEvent = { accountNumber: testAccountNumber };

        const accountMarketValue = await handler.getMarketValue(testEvent);
        logger('Result of market value extraction:', accountMarketValue);

        expect(accountMarketValue).to.exist;
        expect(accountMarketValue).to.have.property('result', 'ERROR');
        expect(accountMarketValue).to.have.property('details');
        const parsedError = JSON.parse(accountMarketValue.details);
        expect(parsedError).to.have.deep.equal({ errors: [{ description: 'Account is inactive', code: 'AccountInactiveError' }]});
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Sends user withdrawal to third party', async () => {
        const testAccountNumber = 'POL122';
        const expectedOptions = {
            method: 'POST',
            uri: `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.withdrawals'), testAccountNumber)}`,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: {
                amount: 1234.56,
                currency: 'ZAR',
                unit: 'WHOLE_CURRENCY',
                bankDetails: {
                    holderName: 'John Doe',
                    accountNumber: '624563712',
                    branchCode: '222626',
                    type: 'Savings',
                    bankName: 'FNB'
                }
            }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 201, body: { } });

        const testEvent = {
            amount: 1234.56,
            currency: 'ZAR',
            accountNumber: 'POL122',
            unit: 'WHOLE_CURRENCY',
            bankDetails: {
                holderName: 'John Doe',
                accountNumber: '624563712',
                branchCode: '222626',
                accountType: 'Savings',
                bankName: 'FNB'
            }
        };

        const resultOfTransmission = await handler.sendWithdrawal(testEvent);
        logger('Investment result from third party:', resultOfTransmission);

        expect(resultOfTransmission).to.exist;
        expect(resultOfTransmission).to.deep.equal({ });
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Catches withdrawal transmission errors', async () => {
        const testAccountNumber = 'POL122';
        const expectedOptions = {
            method: 'POST',
            uri: `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.withdrawals'), testAccountNumber)}`,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: {
                amount: 1234.56,
                currency: 'ZAR',
                unit: 'WHOLE_CURRENCY',
                bankDetails: {
                    holderName: 'John Doe',
                    accountNumber: '624563712',
                    branchCode: '222626',
                    type: 'Savings',
                    bankName: 'FNB'
                }
            }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({
            statusCode: 400,
            body: {
                errors: [{
                    description: 'Account is inactive',
                    code: 'AccountInactiveError'
                }]
            }
        });

        const testEvent = {
            amount: 1234.56,
            currency: 'ZAR',
            unit: 'WHOLE_CURRENCY',
            holderName: 'John Doe',
            accountNumber: 'POL122',
            bankDetails: {
                holderName: 'John Doe',
                accountNumber: '624563712',
                branchCode: '222626',
                accountType: 'Savings',
                bankName: 'FNB'
            }
        };

        const resultOfTransmission = await handler.sendWithdrawal(testEvent);
        logger('Investment result from third party:', resultOfTransmission);

        expect(resultOfTransmission).to.exist;
        expect(resultOfTransmission).to.have.property('result', 'ERROR');
        expect(resultOfTransmission).to.have.property('details');
        const parsedError = JSON.parse(resultOfTransmission.details);
        expect(parsedError).to.have.deep.equal({ errors: [{ description: 'Account is inactive', code: 'AccountInactiveError' }]});
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

    it('Directs save transaction correctly', async () => {
        const testAccountNumber = 'POL23';

        const saveEndpoint = `https://fwtest.jupitersave.com/api/accounts/${testAccountNumber}/investments`;

        const [testAmount, testUnit, testCurrency] = '100::WHOLE_CURRENCY::USD'.split('::');
        const transactionDetails = { accountNumber: testAccountNumber, amount: parseInt(testAmount, 10), unit: testUnit, currency: testCurrency };        

        const saveEvent = { operation: 'INVEST', transactionDetails };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});

        const expectedOptions = {
            method: 'POST',
            uri: saveEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: { amount: parseInt(testAmount, 10), unit: testUnit, currency: testCurrency }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 201, body: { } });

        const resultOfHandler = await handler.addTransaction(saveEvent);
        logger('Investment result from third party:', resultOfHandler);

        expect(resultOfHandler).to.deep.equal({ });
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
        
    });

    it('Directs withdraw transaction correctly', async () => {
        const testAccountNumber = 'POL23';
        const withdrawEndpoint = `https://fwtest.jupitersave.com/api/accounts/${testAccountNumber}/withdrawals`;

        const [testAmount, testUnit, testCurrency] = '100::WHOLE_CURRENCY::USD'.split('::');
        
        const testBankDetails = {
            holderName: 'John Doe',
            accountNumber: '624563712',
            branchCode: '222626',
            accountType: 'Savings',
            bankName: 'FNB'
        };

        const transactionDetails = { 
            accountNumber: testAccountNumber, 
            amount: parseInt(testAmount, 10), 
            unit: testUnit, 
            currency: testCurrency,
            bankDetails: testBankDetails 
        };

        const withdrawEvent = { operation: 'WITHDRAW', transactionDetails };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});

        const expectedBankDetails = { ...testBankDetails, type: testBankDetails.accountType };
        Reflect.deleteProperty(expectedBankDetails, 'accountType');
        const expectedOptions = {
            method: 'POST',
            uri: withdrawEndpoint,
            agentOptions: { cert: 'access-key-or-crt', key: 'access-key-or-crt' },
            resolveWithFullResponse: true,
            json: true,
            body: { amount: parseInt(testAmount, 10), unit: testUnit, currency: testCurrency, bankDetails: expectedBankDetails }
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => 'access-key-or-crt' }})});
        requestStub.resolves({ statusCode: 201, body: { } });

        const resultOfHandler = await handler.addTransaction(withdrawEvent);
        logger('Investment result from third party:', resultOfHandler);

        expect(resultOfHandler).to.deep.equal({ });
        expect(getObjectStub).to.have.been.calledTwice;
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
    });

});
