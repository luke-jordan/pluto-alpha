'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify-test');
const config = require('config');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const requestStub = sinon.stub();

const handler = proxyquire('../bank-verify-handler', {
    'request-promise': requestStub
});

const expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST BANK ACC VERIFICATION INITIALIZER ***', () => {
    const testUserId = uuid();
    const testAccountNumber = '3243463245';
    const testAccountType = 'SAVINGSACCOUNT';
    const testIdNumber = '8307065125487';
    const testReference = 'TEST_REF';

    beforeEach(() => {
        resetStubs(requestStub);
    });

    it('Verifies an individuals bank account', async () => {
        const expectedRequestArgs = {
            method: 'POST',
            url: config.get('pbVerify.endpoint'),
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'bvs_details[verificationType]': 'Individual',
                'bvs_details[bank_name]': 'NEDBANK',
                'bvs_details[acc_number]': testAccountNumber,
                'bvs_details[acc_type]': testAccountType,
                'bvs_details[yourReference]': testReference,
                'bvs_details[id_number]': testIdNumber,
                'bvs_details[initials]': 'JF',
                'bvs_details[surname]': 'Kennedy'
            },
            json: true
        };

        const expectedResponse = {
            'Status': 'Success',
            'XDSBVS': {
              'JobStatus': 'Enquiry Submitted Successfully',
              'JobID': '72828608'
            }
          };
        
        requestStub.withArgs(expectedRequestArgs).resolves(expectedResponse);

        const testEvent = {
            bankName: 'NEDBANK',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResponse);
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Fails on unexpected response from third party', async () => {
        const expectedRequestArgs = {
            method: 'POST',
            url: config.get('pbVerify.endpoint'),
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'bvs_details[verificationType]': 'Individual',
                'bvs_details[bank_name]': 'ABSA',
                'bvs_details[acc_number]': testAccountNumber,
                'bvs_details[acc_type]': testAccountType,
                'bvs_details[yourReference]': testReference,
                'bvs_details[id_number]': testIdNumber,
                'bvs_details[initials]': 'JF',
                'bvs_details[surname]': 'Kennedy'
            },
            json: true
        };

        requestStub.withArgs(expectedRequestArgs).resolves('Balderdash');

        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Balderdash' });
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Fails on missing bank name', async () => {
        const testEvent = {
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Missing bank name' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on unsupported bank', async () => {
        const testEvent = {
            bankName: 'JP MORGAN',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'The bank you have entered is currently not supported' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing account number', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Missing account number' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing account type', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Missing account type' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on invalid account type', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: 'HEDGEFUND',
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Invalid account type' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing reference', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Missing reference' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing national id number on verification of an individuals bank account', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy'
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'The individuals national id is required for individual account verification' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing initials on verification of and individuals bank account', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'The individuals initials are required for individual account verification' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing surname on verification of an individuals bank account', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountType,
            reference: testReference,
            initials: 'JF',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'The individuals surname is required for individual account verification' });
        expect(requestStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST BANK ACC VERIFICATION STATUS CHECKER ***', () => {
    const testJobId = '73773590';
    const testUserId = uuid();

    const testResponse = {
        'Status': 'Success',
        'Results': {
            'RECORDINDICATOR': '3244087',
            'SEQUENCENUMBER': 'Not Available',
            'BRANCHNUMBER': '250655',
            'ACCOUNTNUMBER': '623730987987',
            'ACCOUNTTYPE': 'CURRENTCHEQUEACCOUNT',
            'IDNUMBER': '79050158908798',
            'IDTYPE': 'Not Available',
            'INITIALS': 'J',
            'SURNAME': 'GOOFY',
            'TAXREFERENCENUMBER': 'Not Available',
            'CLIENTUSERREFERENCE': '1436989',
            'SUBBILLINGID': '1436989',
            'ERRORCONDITIONNUMBER': 'Not Available',
            'ACCOUNTFOUND': 'Yes',
            'IDNUMBERMATCH': 'Yes',
            'INITIALSMATCH': 'Yes',
            'SURNAMEMATCH': 'Yes',
            'ACCOUNT-OPEN': 'Yes',
            'ACCOUNTDORMANT': 'Not Available',
            'ACCOUNTOPENFORATLEASTTHREEMONTHS': 'Yes',
            'ACCOUNTACCEPTSDEBITS': 'Yes',
            'ACCOUNTACCEPTSCREDITS': 'Yes',
            'TAXREFERENCEMATCH': 'Not Available',
            'ACCOUNTISSUER': 'Not Available',
            'ACCOUNTTYPERETURN': 'Yes'
        }
    };

    beforeEach(() => {
        resetStubs(requestStub);
    });

    it('Gets bank account verification status', async () => {
        const expectedRequestArgs = {
            method: 'POST',
            url: config.get('pbVerify.endpoint'),
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'jobId': testJobId
            },
            json: true
          }

        requestStub.withArgs(expectedRequestArgs).resolves(testResponse);
        const testEvent = { jobId: testJobId };

        const result = await handler.checkStatus(testEvent);
        logger('Result of account verification check:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(testResponse);
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Fails on unexpected response from third party', async () => {
        const expectedRequestArgs = {
            method: 'POST',
            url: config.get('pbVerify.endpoint'),
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'jobId': testJobId
            },
            json: true
        };

        requestStub.withArgs(expectedRequestArgs).resolves({ Status: 'Failure' });
        
        const testEvent = { jobId: testJobId };

        const result = await handler.checkStatus(testEvent);
        logger('Result of account verification check:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: { Status: 'Failure' }});
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Throws (and catches) error on missing job id', async () => {        
        const testEvent = { };

        const result = await handler.checkStatus(testEvent);
        logger('Result of account verification check on error:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ Status: 'Error', details: 'Missing job id' });
        expect(requestStub).to.have.not.been.called;
    })

});
