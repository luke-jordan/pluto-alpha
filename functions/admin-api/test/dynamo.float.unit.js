'use strict';

const logger = require('debug')('jupiter:admin:dynamo-float-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const momentStub = sinon.stub();

const docClientGetStub = sinon.stub();
const docClientScanStub = sinon.stub();
const docClientUpdateStub = sinon.stub();

class MockDocClient {
    constructor () {
        this.get = docClientGetStub;
        this.scan = docClientScanStub;
        this.update = docClientUpdateStub;
    }
}

const dynamo = proxyquire('../persistence/dynamo.float', {
    'aws-sdk': { DynamoDB: { DocumentClient: MockDocClient }},
    'moment': momentStub,
    '@noCallThru': true
});

describe('*** UNIT TEST DYNAMO FLOAT ***', () => {
    const testFloatId = uuid();
    const testClientId = uuid();

    beforeEach(() => {
        helper.resetStubs(docClientUpdateStub, docClientScanStub, docClientGetStub);
    });
    
    it('Lists country clients', async () => {
        const expectedResultFromDB = { 'client_id': testClientId };
        docClientScanStub.withArgs({ TableName: config.get('tables.countryClientTable') }).returns({ promise: () => ({ Items: [expectedResultFromDB, expectedResultFromDB] })});
        const expectedResult = { clientId: testClientId };

        const resultOfListing = await dynamo.listCountriesClients();
        logger('Result of country client listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedResult, expectedResult]);
        expect(docClientScanStub).to.have.been.calledOnceWithExactly({ TableName: config.get('tables.countryClientTable') });
    });

    it('Lists client floats', async () => {
        const expectedResultFromDB = { 'float_id': testFloatId };
        docClientScanStub.withArgs({ TableName: config.get('tables.clientFloatTable') }).returns({ promise: () => ({ Items: [expectedResultFromDB, expectedResultFromDB] })});
        const expectedResult = { floatId: testFloatId };

        const resultOfListing = await dynamo.listClientFloats();
        logger('Result of client float listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedResult, expectedResult]);
        expect(docClientScanStub).to.have.been.calledOnceWithExactly({ TableName: config.get('tables.clientFloatTable') });
    });

    it('Fetches client float variables', async () => {
        const expectedResultFromDB = { 'float_id': testFloatId, 'client_id': testClientId };
        const expectedQueryArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId }
        };

        docClientGetStub.withArgs(expectedQueryArgs).returns({ promise: () => ({ Item: expectedResultFromDB })});
        const expectedResult = { floatId: testFloatId, clientId: testClientId };

        const clientFloatVars = await dynamo.fetchClientFloatVars(testClientId, testFloatId);
        logger('Result of client float listing:', clientFloatVars);
        
        expect(clientFloatVars).to.exist;
        expect(clientFloatVars).to.deep.equal(expectedResult);
        expect(docClientGetStub).to.have.been.calledOnceWithExactly(expectedQueryArgs);
    });

    it('Updates client float vars', async () => {
        const testPrincipalVars = {
            accrualRateAnnualBps: '',
            bonusPoolShareOfAccrual: '',
            clientShareOfAccrual: '',
            prudentialFactor: ''
        };

        const params = {
            clientId: testClientId,
            floatId: testFloatId,
            newPrincipalVars: testPrincipalVars,
            newReferralDefaults: { },
            newComparatorMap: { }
        };

        const expectedUpdateArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId },
            UpdateExpression: 'set accrual_rate_annual_bps = :arr, bonus_pool_share_of_accrual = :bpoolshare, client_share_of_accrual = :csharerate, prudential_factor = :prud',
            ExpressionAttributeValues: { ':arr': '', ':bpoolshare': '', ':csharerate': '', ':prud': '' },
            ReturnValues: 'ALL_NEW'
        };

        const expectedResultFromDB = { 'float_id': testFloatId, 'client_id': testClientId };
        docClientUpdateStub.withArgs(expectedUpdateArgs).returns({ promise: () => ({ Attributes: expectedResultFromDB })});

        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: { floatId: testFloatId, clientId: testClientId }
        };

        const updateResult = await dynamo.updateClientFloatVars(params);
        logger('Result of float variables update:', updateResult);
        logger('args:', docClientUpdateStub.getCall(0).args);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(expectedResult);
        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });

    it('Updates client float vars', async () => {
        const testPrincipalVars = {
            accrualRateAnnualBps: '',
            bonusPoolShareOfAccrual: '',
            clientShareOfAccrual: '',
            prudentialFactor: ''
        };

        const params = {
            clientId: testClientId,
            floatId: testFloatId,
            newPrincipalVars: testPrincipalVars,
            newReferralDefaults: { },
            newComparatorMap: { }
        };

        const expectedUpdateArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId },
            UpdateExpression: 'set accrual_rate_annual_bps = :arr, bonus_pool_share_of_accrual = :bpoolshare, client_share_of_accrual = :csharerate, prudential_factor = :prud',
            ExpressionAttributeValues: { ':arr': '', ':bpoolshare': '', ':csharerate': '', ':prud': '' },
            ReturnValues: 'ALL_NEW'
        };

        const expectedResultFromDB = { 'float_id': testFloatId, 'client_id': testClientId };
        docClientUpdateStub.withArgs(expectedUpdateArgs).returns({ promise: () => ({ Attributes: expectedResultFromDB })});

        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: { floatId: testFloatId, clientId: testClientId }
        };

        const updateResult = await dynamo.updateClientFloatVars(params);
        logger('Result of float variables update:', updateResult);
        logger('args:', docClientUpdateStub.getCall(0).args);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(expectedResult);
        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });

    it('Updates comparator rates', async () => {
        const newComparatorMap = { 
            intervalUnit: 'WHOLE_CURRENCY',
            rateUnit: 'BASIS_POINT',
            rates: {
                'JPM': {
                    'label': 'JP Morgan Chase',
                    '999': 20
                }
            }
        };

        const params = {
            clientId: testClientId,
            floatId: testFloatId,
            newComparatorMap
        };

        const expectedMap = {
            'interval_unit': 'WHOLE_CURRENCY',
            'rate_unit': 'BASIS_POINT',
            'rates': newComparatorMap.rates 
        };

        const expectedUpdateArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId },
            UpdateExpression: 'set comparator_rates = :crmap',
            ExpressionAttributeValues: { ':crmap': expectedMap },
            ReturnValues: 'ALL_NEW'
        };

        const expectedResultFromDB = { 'comparator_rates': expectedMap };
        docClientUpdateStub.withArgs(expectedUpdateArgs).returns({ promise: () => ({ Attributes: expectedResultFromDB })});

        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: { comparatorRates: newComparatorMap }
        };

        const updateResult = await dynamo.updateClientFloatVars(params);
        logger('Result of float variables update:', updateResult);
        logger('args:', docClientUpdateStub.getCall(0).args);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(expectedResult);
        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });

});

describe('*** UNIT TEST OTP VERIFIED ***', () => {

    const testUserId = uuid();

    beforeEach(() => {
        helper.resetStubs(docClientUpdateStub, docClientScanStub, docClientGetStub);
    });

    it('Returns true if OTP has been verified', async () => {
        const currentUnix = moment().unix();
        momentStub.returns({ unix: () => currentUnix });
        
        const expectedParams = {
            TableName: config.get('tables.authCacheTable'),
            Key: { 'user_id_event_type': `${testUserId}::OTP_VERIFIED` },
            FilterExpression: `expires_at >= ${currentUnix}`,
            ProjectionExpression: 'expires_at'
        };

        docClientGetStub.returns({ promise: () => ({ Item: { expiresAt: moment().add(1, 'minute').unix() } }) });

        const result = await dynamo.verifyOtpPassed(testUserId);
        logger('Result of boolean assertion on verification event in cache:', result);

        expect(result).to.exist;
        expect(result).to.be.true;
        expect(docClientGetStub).to.have.been.calledOnceWithExactly(expectedParams);
    });

    it('Returns false if OTP event expired', async () => {
        const currentUnix = moment().unix();
        momentStub.returns({ unix: () => currentUnix });
        
        const expectedParams = {
            TableName: config.get('tables.authCacheTable'),
            Key: { 'user_id_event_type': `${testUserId}::OTP_VERIFIED` },
            FilterExpression: `expires_at >= ${currentUnix}`,
            ProjectionExpression: 'expires_at'
        };

        docClientGetStub.returns({ promise: () => ({ Item: { expiresAt: moment().subtract(1, 'minute').unix() } }) });

        const result = await dynamo.verifyOtpPassed(testUserId);
        logger('Result of boolean assertion on verification event in cache:', result);

        expect(result).to.exist;
        expect(result).to.be.false;
        expect(docClientGetStub).to.have.been.calledOnceWithExactly(expectedParams);
    });

    it('Returns false if no OTP event', async () => {
        const currentUnix = moment().unix();
        momentStub.returns({ unix: () => currentUnix });
        
        const expectedParams = {
            TableName: config.get('tables.authCacheTable'),
            Key: { 'user_id_event_type': `${testUserId}::OTP_VERIFIED` },
            FilterExpression: `expires_at >= ${currentUnix}`,
            ProjectionExpression: 'expires_at'
        };

        docClientGetStub.returns({ promise: () => ({ }) });

        const result = await dynamo.verifyOtpPassed(testUserId);
        
        expect(result).to.exist;
        expect(result).to.be.false;
        expect(docClientGetStub).to.have.been.calledOnceWithExactly(expectedParams);
    });


});
