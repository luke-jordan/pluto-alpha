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
const docClientQueryStub = sinon.stub();
const docClientScanStub = sinon.stub();

const docClientUpdateStub = sinon.stub();
const docClientPutStub = sinon.stub();

class MockDocClient {
    constructor () {
        this.get = docClientGetStub;
        this.query = docClientQueryStub;
        this.scan = docClientScanStub;
        this.update = docClientUpdateStub;
        this.put = docClientPutStub;
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

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(expectedResult);
        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });

    it('Updates user referral defaults', async () => {
        const newReferralDefaults = {
            boostAmountOffered: '10000::HUNDREDTH_CENT::USD',
            redeemConditionType: 'TARGET_BALANCE',
            redeemConditionAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            daysToMaintain: 30,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'test_client_id',
                floatId: 'primary_cash'
            }
        };

        const expectedMap = {
            'boost_amount_offered': '10000::HUNDREDTH_CENT::USD',
            'redeem_condition_type': 'TARGET_BALANCE',
            'redeem_condition_amount': { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            'days_to_maintain': 30,
            'boost_source': {
                'bonus_pool_id': 'primary_bonus_pool',
                'client_id': 'test_client_id',
                'float_id': 'primary_cash'
            }
        };

        docClientUpdateStub.returns({ promise: () => ({ Attributes: { 'user_referral_defaults': expectedMap } })});

        const params = {
            clientId: testClientId,
            floatId: testFloatId,
            newReferralDefaults
        };

        const updateResult = await dynamo.updateClientFloatVars(params);
        logger('Result of float variables update:', updateResult);

        const expectedUpdateArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId },
            UpdateExpression: 'set user_referral_defaults = :rffdef',
            ExpressionAttributeValues: { ':rffdef': expectedMap },
            ReturnValues: 'ALL_NEW'
        };

        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: { userReferralDefaults: newReferralDefaults }
        };

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal(expectedResult);
        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });

    it('Updates locked save bonus', async () => {
        const testPrincipalVars = {
            lockedSaveBonus: { 7: 0.5, 14: 0.7, 30: 1.01, 60: 1.05, 90: 1.1 }
        };

        const params = {
            newPrincipalVars: testPrincipalVars,
            clientId: testClientId,
            floatId: testFloatId
        };

        const expectedResultFromDB = { 'float_id': testFloatId, 'client_id': testClientId };
        docClientUpdateStub.returns({ promise: () => ({ Attributes: expectedResultFromDB })});

        const updateResult = await dynamo.updateClientFloatVars(params);
        expect(updateResult).to.exist;

        const expectedResult = {
            result: 'SUCCESS',
            returnedAttributes: { floatId: testFloatId, clientId: testClientId }
        };

        expect(updateResult).to.deep.equal(expectedResult);

        const expectedUpdateArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId },
            UpdateExpression: 'set locked_save_bonus = :lsbonus',
            ExpressionAttributeValues: { ':lsbonus': { 14: 0.7, 30: 1.01, 60: 1.05, 7: 0.5, 90: 1.1 } },
            ReturnValues: 'ALL_NEW'
        };

        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(expectedUpdateArgs);
    });
});

describe('*** UNIT TEST REFERRAL CODE ***', () => {

    const testFloatId = 'some_mmkt_float';
    const testClientId = 'client_somewhere';

    beforeEach(() => helper.resetStubs(docClientGetStub));

    it('Returns country code for client float', async () => {
        const expectedQueryArgs = {
            TableName: config.get('tables.clientFloatTable'),
            Key: { 'client_id': testClientId, 'float_id': testFloatId },
            ProjectionExpression: ['country_code']
        };
        const expectedItem = { 'client_id': testClientId, 'float_id': testFloatId, 'country_code': 'RWA' };

        docClientGetStub.withArgs(expectedQueryArgs).returns({ promise: () => ({ Item: expectedItem })});

        const resultOfCall = await dynamo.findCountryForClientFloat(testClientId, testFloatId);
        expect(resultOfCall).to.equal('RWA');
    });

    it('Returns active referral codes for client float', async () => {
        const testBoostSource = 'some_bonus_pool_id';
        const someReferralCodes = ['LETMEIN', 'NOPLEASE', 'IREALLYWANTOJOIN'];

        const mockReferralAmounts = someReferralCodes.map(() => Math.floor(Math.random() * 1000000));

        const mockReferralCodeFromTable = (code, idx) => ({
            'country_code': 'RWA',
            'referral_code': code,
            'client_id_float_id': `${testClientId}::${testFloatId}`,
            'code_type': 'CHANNEL',
            'context': {
                'boost_amount_offered': `${mockReferralAmounts[idx]}::HUNDREDTH_CENT::USD`,
                'bonus_pool_id': testBoostSource
            },
            'tags': ['ALPHA']
        });

        const mockCodesFromTable = someReferralCodes.map((code, idx) => mockReferralCodeFromTable(code, idx));

        const expectedQueryArgs = {
            TableName: config.get('tables.activeReferralCodeTable'),
            IndexName: 'ReferralCodeFloatIndex',
            KeyConditionExpression: '#cifi = :client_id_float_id',
            FilterExpression: 'code_type <> :usr',
            ExpressionAttributeNames: {
                '#cifi': 'client_id_float_id'
            },
            ExpressionAttributeValues: {
                ':client_id_float_id': `${testClientId}::${testFloatId}`,
                ':usr': 'USER'
            }
        };

        docClientQueryStub.withArgs(expectedQueryArgs).returns({ promise: () => ({ Items: mockCodesFromTable })});

        const expectedCode = (code, idx) => ({
            referralCode: code,
            countryCode: 'RWA',
            clientId: testClientId,
            floatId: testFloatId,
            codeType: 'CHANNEL',
            bonusAmount: {
                amount: mockReferralAmounts[idx],
                unit: 'HUNDREDTH_CENT',
                currency: 'USD'
            },
            bonusSource: testBoostSource,
            tags: ['ALPHA']
        });

        const mockCodesResponse = someReferralCodes.map((code, idx) => expectedCode(code, idx));

        const resultOfFetch = await dynamo.listReferralCodes(testClientId, testFloatId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(mockCodesResponse);
    });

});

describe('*** UNIT TEST PUT ADMIN LOG ***', () => {

    const testAdminId = uuid();

    beforeEach(() => helper.resetStubs(docClientPutStub, momentStub));

    it('Adds an admin log to the table', async () => {
        const testMoment = moment();
        momentStub.returns(testMoment);

        const testEventType = 'REFERRAL_CODE_DEACTIVATED';

        const expectedPutArgs = {
            TableName: config.get('tables.adminLogsTable'),
            Item: {
                'admin_user_id_event_type': `${testAdminId}::${testEventType}`,
                'creation_time': testMoment.valueOf(),
                'context': {
                    'reason_to_log': 'Stuff happened'
                }
            },
            ExpressionAttributeNames: {
                '#auid': 'admin_user_id_event_type'
            },    
            ConditionExpression: 'attribute_not_exists(#auid) and attribute_not_exists(creation_time)'
        };

        docClientPutStub.returns({ promise: () => ({ })});

        const resultOfLog = await dynamo.putAdminLog(testAdminId, testEventType, { reasonToLog: 'Stuff happened' });
        expect(resultOfLog).to.exist;
        expect(resultOfLog).to.deep.equal({ result: 'SUCCESS' });

        expect(docClientPutStub).to.have.been.calledOnceWithExactly(expectedPutArgs);
        
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
