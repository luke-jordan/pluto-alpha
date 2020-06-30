'use strict';

const config = require('config');
const moment = require('moment');
const crypto = require('crypto');

const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');

chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const fetchStub = sinon.stub();
const insertStub = sinon.stub();
const deleteStub = sinon.stub();
const updateStub = sinon.stub();

const cacheGetStub = sinon.stub();
const cacheSetStub = sinon.stub();
const momentStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

// todo : actually cover
class MockRedis { 
    constructor () { 
        this.get = cacheGetStub;
        this.set = cacheSetStub;
    }
}

const dynamo = proxyquire('../persistence/dynamodb', {
    'dynamo-common': {
        fetchSingleRow: fetchStub,
        insertNewRow: insertStub,
        deleteRow: deleteStub,
        updateRow: updateStub,
    },
    'ioredis': MockRedis,
    'moment': momentStub,
    '@noCallThru': true
});

const testClientId = 'a_client_somewhere';
const testFloatId = 'usd_cash_primary';

const expectedFloatParameters = {
    'accrualRateBps': 250,
    'bonusPoolShare': 0.1,
    'clientCoShare': 0.1,
    'prudentialDiscount': 0.1,
    'timeZone': 'America/New_York',
    'currency': 'USD'
};

describe('** UNIT TESTING DYNAMO FETCH **', () => {

    before(() => {
        const expectedColumns = ['accrualRateAnnualBps', 'bonusPoolShareOfAccrual', 'clientShareOfAccrual', 'prudentialFactor', 'defaultTimezone', 'currency', 'comparatorRates', 'bankDetails']; 
        fetchStub.withArgs(config.get('tables.clientFloatVars'), { clientId: testClientId, floatId: testFloatId }, expectedColumns).
            resolves(expectedFloatParameters);
    });

    beforeEach(() => fetchStub.resetHistory());

    it('Fetches paramaters correctly when passed both IDs', async () => {
        const fetchedParams = await dynamo.fetchFloatVarsForBalanceCalc(testClientId, testFloatId);
        expect(fetchedParams).to.exist;
        expect(fetchedParams).to.deep.equal(expectedFloatParameters);
    });

    it('Throws an error when cannot find variables for client/float pair', async () => {
        const badClientId = `${testClientId}_mangled`;
        const expectedError = `Error! No config variables found for client-float pair: ${badClientId}-${testFloatId}`;
        await expect(dynamo.fetchFloatVarsForBalanceCalc(badClientId, testFloatId)).to.be.rejectedWith(expectedError);
    });

    it('Throws an error when missing one of the two needed IDs', async () => {
        const errorMsg = 'Error! One of client ID or float ID missing';
        await expect(dynamo.fetchFloatVarsForBalanceCalc(testClientId)).to.be.rejectedWith(errorMsg);
    });

    it('Handles warm up call', async () => {
        fetchStub.withArgs(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' }).resolves({});
        const warmupResult = await dynamo.warmupCall();
        expect(warmupResult).to.deep.equal({});
        expect(fetchStub).to.have.been.calledOnceWithExactly(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' });
    });

});

describe.only('** UNIT TESTING BANK DETAILS HANDLING **', () => {

    beforeEach(() => {
        fetchStub.reset();
        insertStub.reset();
    });

    const mockUserId = uuid();

    const mockBankDetails = {
        bankName: 'JPMs',
        accountNumber: '928392739187391',
        accountType: 'SAVINGS'    
    };

    const expectedHash = crypto.createHash('sha256').update(JSON.stringify(mockBankDetails)).digest('hex');

    it('Hashes and fetches prior bank verification results correctly', async () => {
        const mockCreatedTime = moment().subtract(3, 'days');
        // const mockCutOffTime = moment().subtract(180, 'days');

        fetchStub.resolves({ systemWideUserId: mockUserId, accountHash: expectedHash, verificationStatus: 'VERIFIED', creationTime: mockCreatedTime.valueOf() });

        momentStub.withArgs().returns(moment());
        momentStub.withArgs(mockCreatedTime.valueOf()).returns(mockCreatedTime);

        const result = await dynamo.fetchBankVerificationResult(mockUserId, mockBankDetails);
        expect(result).to.deep.equal({ verificationStatus: 'VERIFIED' });

        const expectedKey = { systemWideUserId: mockUserId, accountHash: expectedHash };
        expect(fetchStub).to.have.been.calledOnceWithExactly('BankVerificationTable', expectedKey);
    });

    it('Returns appropriately if nothing is found', async () => {
        fetchStub.resolves({});

        const result = await dynamo.fetchBankVerificationResult(mockUserId, mockBankDetails);
        expect(result).to.deep.equal({ verificationStatus: 'NO_RECORD' });

        const expectedKey = { systemWideUserId: mockUserId, accountHash: expectedHash };
        expect(fetchStub).to.have.been.calledOnceWithExactly('BankVerificationTable', expectedKey);
    });

    it('Excludes if verification is too old, and cleans row', async () => {
        const mockCreatedTime = moment().subtract(181, 'days');

        momentStub.withArgs().returns(moment());
        momentStub.withArgs(mockCreatedTime.valueOf()).returns(mockCreatedTime);
        
        fetchStub.resolves();
        deleteStub.resolves({ result: 'DELETED' });

        const result = await dynamo.fetchBankVerificationResult(mockUserId, mockBankDetails);
        expect(result).to.deep.equal({ verificationStatus: 'NO_RECORD' });

        expect(deleteStub).to.have.been.calledOnceWith({ 
            tableName: 'BankVerificationTable',
            itemKey: { systemWideUserId: mockUserId, accountHash: expectedHash }
        });

    });

    it('Hashes and stores correctly when passed details', async () => {
        const mockPersistedTime = moment();

        insertStub.resolves({ result: 'SUCCESS' });
        const result = await dynamo.setBankVerificationResult(mockUserId, mockBankDetails, 'VERIFIED');
        expect(result).to.deep.equal({ result: 'SUCCESS', persistedTime: mockPersistedTime });

        const expectedItem = {
            systemWideUserId: mockUserId,
            accountHash: expectedHash,
            verificationStatus: 'VERIFIED',
            creationTime: mockPersistedTime.valueOf(),
            lastAccessTime: mockPersistedTime.valueOf()
        };

        expect(insertStub).to.have.been.calledOnceWithExactly('BankVerificationTable', ['systemWideUserId', 'accountHash'], expectedItem);
    });

    it('Updates last access time on end of withdrawal, if verified', async () => {
        const mockUpdatedTime = moment();

        updateStub.resolves({ result: 'SUCCESS' });
        const result = await dynamo.updateLastVerificationUseTime(mockUserId, mockBankDetails, mockUpdatedTime);
        expect(result).to.deep.equal({ result: 'SUCCESS' });

        expect(updateStub).to.have.been.calledOnceWithExactly({
            tableName: 'BankVerificationTable',
            itemKey: { systemWideUserId: mockUserId, accountHash: expectedHash },
            updateExpression: 'set last_access_time = :at',
            substitutionDict: { ':at': mockUpdatedTime.valueOf() },
            returnOnlyUpdated: true
        });
    });

});
