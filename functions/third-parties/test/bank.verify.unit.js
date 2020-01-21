'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify-test');
const config = require('config');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const requestStub = sinon.stub();

const handler = proxyquire('../bank-verify-handler', {
    'request-promise': requestStub
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST BANK ACC VERIFICATION INITIALIZER ***', () => {
    
    const testAccountNumber = '3243463245';
    
    const testAccountTypeInput = 'CURRENT';
    const testAccountTypeRequest = 'CURRENTCHEQUEACCOUNT';

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
                'bvs_details[acc_type]': testAccountTypeRequest,
                'bvs_details[yourReference]': testReference,
                'bvs_details[id_number]': testIdNumber,
                'bvs_details[initials]': 'JF',
                'bvs_details[surname]': 'Kennedy'
            },
            json: true
        };

        const mockRequestResponse = {
            'Status': 'Success',
            'XDSBVS': {
              'JobStatus': 'Enquiry Submitted Successfully',
              'JobID': '72828608'
            }
        };

        const expectedResponse = {
            status: 'SUCCESS',
            jobId: '72828608'
        };
        
        requestStub.withArgs(expectedRequestArgs).resolves(mockRequestResponse);

        const testEvent = {
            bankName: 'NEDBANK',
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
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
                'bvs_details[acc_type]': testAccountTypeRequest,
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
            accountType: testAccountTypeInput,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'Balderdash' });
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Fails on missing bank name', async () => {
        const testEvent = {
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_BANK_NAME' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on unsupported bank', async () => {
        const testEvent = {
            bankName: 'JP MORGAN',
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };

        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'BANK_NOT_SUPPORTED' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing account number', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountType: testAccountTypeInput,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_ACCOUNT_NUMBER' });
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
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_ACCOUNT_TYPE' });
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
        expect(result).to.deep.equal({ status: 'ERROR', details: 'INVALID_ACCOUNT_TYPE' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing reference', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
            initials: 'JF',
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_REFERENCE' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing national id number on verification of an individuals bank account', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
            reference: testReference,
            initials: 'JF',
            surname: 'Kennedy'
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_NATIONAL_ID' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing initials on verification of and individuals bank account', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
            reference: testReference,
            surname: 'Kennedy',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_INITIALS' });
        expect(requestStub).to.have.not.been.called;
    });

    it('Fails on missing surname on verification of an individuals bank account', async () => {
        const testEvent = {
            bankName: 'ABSA',
            accountNumber: testAccountNumber,
            accountType: testAccountTypeInput,
            reference: testReference,
            initials: 'JF',
            nationalId: testIdNumber
        };
        
        const result = await handler.initialize(testEvent);
        logger('Account verification resulted in:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'NO_SURNAME' });
        expect(requestStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST BANK ACC VERIFICATION STATUS CHECKER ***', () => {
    const testJobId = '73773590';
    
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

    const expectedTransformedOkay = { result: 'VERIFIED' };

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
        };

        requestStub.withArgs(expectedRequestArgs).resolves(testResponse);
        const testEvent = { jobId: testJobId };

        const result = await handler.checkStatus(testEvent);
        logger('Result of account verification check:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedTransformedOkay);
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Reports failure if bank account ID number does not match', async () => {
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

        const failureResponse = JSON.parse(JSON.stringify(testResponse));
        failureResponse['Results']['IDNUMBERMATCH'] = 'No';
        requestStub.withArgs(expectedRequestArgs).resolves(failureResponse);
        const testEvent = { jobId: testJobId };

        const result = await handler.checkStatus(testEvent);
        logger('Result of account verification check:', result);

        expect(result).to.deep.equal({ result: 'FAILED', cause: 'ID number does not match' });
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Reports failure if account is not open or does not accept credits', async () => {
        const testEvent = { jobId: testJobId };

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

        const failureResponse = JSON.parse(JSON.stringify(testResponse));
        failureResponse['Results']['ACCOUNT-OPEN'] = 'No';
        requestStub.withArgs(expectedRequestArgs).resolves(failureResponse);

        const result = await handler.checkStatus(testEvent);
        expect(result).to.deep.equal({ result: 'FAILED', cause: 'Account not open' });

        const secondFailureReponse = JSON.parse(JSON.stringify(testResponse));
        secondFailureReponse['Results']['ACCOUNTACCEPTSCREDITS'] = 'No';
        requestStub.withArgs(expectedRequestArgs).resolves(secondFailureReponse);
        
        const secondResult = await handler.checkStatus(testEvent);
        expect(secondResult).to.deep.equal({ result: 'FAILED', cause: 'Account does not accept credits' });
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
        expect(result).to.deep.equal({ status: 'ERROR', details: { Status: 'Failure' }});
        expect(requestStub).to.have.been.calledOnceWithExactly(expectedRequestArgs);
    });

    it('Throws (and catches) error on missing job id', async () => {        
        const testEvent = { };

        const result = await handler.checkStatus(testEvent);
        logger('Result of account verification check on error:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ status: 'ERROR', details: 'Missing job id' });
        expect(requestStub).to.have.not.been.called;
    });

});
