'use strict';

const logger = require('debug')('jupiter:referral:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');
const status = require('statuses');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const expect = chai.expect;
const proxyquire = require('proxyquire');

const testHelper = require('./referral.test.helper');

const fetchRowStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../referral-use-handler', {
    'dynamo-common': {
        fetchSingleRow: fetchRowStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'moment': momentStub
});

const testBetaCode = 'ABRACADABRA';
const testCodeCases = 'Abracadabra  ';

const activeCodeTable = config.get('tables.activeCodes');
const clientFloatTable = config.get('tables.clientFloatTable');

const relevantColumns = ['referralCode', 'codeType', 'expiryTimeMillis', 'context', 'clientId', 'floatId'];

describe('*** UNIT TESTING VERIFY REFERRAL CODE ***', () => {

    const nonExistentCode = 'LETMEIN';
    const testCountryCode = 'RWA';

    const returnedCodeDetails = {
        referralCode: testBetaCode,
        countryCode: testCountryCode,
        codeType: 'BETA',
        expiryTimeMillis: moment().add(1, 'month').valueOf(),
        clientId: 'someClient',
        floatId: 'someFloat',
        context: {
            openingBonus: {
                'amount': '5',
                'currency': 'USD',
                'unit': 'WHOLE_CURRENCY'
            }
        }
    };

    beforeEach(() => testHelper.resetStubs(fetchRowStub));

    it('Warms up referral verify lambda', async () => {
        const mockEvent = { warmupCall: true };

        const result = await handler.verify(mockEvent);
        logger('Result of warm up call to lambda:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'WARMED' });
    });

    it('Happy path referral code verification, when it exists, normal body', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(relevantColumns)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testBetaCode, countryCode: testCountryCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
    });

    it('Happy path referral code verification, case insensitive', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(relevantColumns)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testCodeCases, countryCode: testCountryCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, sinon.match(relevantColumns));
    });

    it('Happy path get float details as well', async () => {
        const mockReferralDefaults = { shareLink: 'https://jupitersave.com/other' };
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(relevantColumns)).resolves(returnedCodeDetails);
        fetchRowStub.withArgs(clientFloatTable, { clientId: 'someClient', floatId: 'someFloat' }, ['user_referral_defaults'])
            .resolves({ userReferralDefaults: mockReferralDefaults });
        const resultOfFetch = await handler.verify({ referralCode: testCodeCases, countryCode: testCountryCode, includeFloatDefaults: true });
        const verificationBody = testHelper.standardOkayChecks(resultOfFetch);
        
        const expectedDetails = { ...returnedCodeDetails, floatDefaults: mockReferralDefaults };
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: expectedDetails });
        expect(fetchRowStub).to.have.been.calledTwice;
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, sinon.match(relevantColumns));
        expect(fetchRowStub).to.have.been.calledWithExactly(clientFloatTable, { clientId: 'someClient', floatId: 'someFloat' }, ['user_referral_defaults']);
    });

    it('Happy path referral code does not exist / is not active', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: nonExistentCode }, relevantColumns).resolves({ });
        const resultOfVerification = await handler.verify({ referralCode: nonExistentCode, countryCode: testCountryCode });
        const verificationBody = testHelper.expectedErrorChecks(resultOfVerification, status['Not Found']);
        expect(verificationBody).to.deep.equal({ result: 'CODE_NOT_FOUND' });
    });

    it('Referral code verification swallows errors appropriately', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: 'THISISBAD' }, relevantColumns).rejects(new Error('Got that wrong!'));
        const errorThrow = await handler.verify({ referralCode: 'thisIsBad', countryCode: testCountryCode });
        expect(errorThrow).to.exist;
        expect(errorThrow).to.deep.equal({ statusCode: 500, body: JSON.stringify('Got that wrong!') });
    });

});

describe('*** UNIT TEST REFERRAL BOOST REDEMPTION ***', () => {
    const testReferringUserId = uuid();
    const testReferredUserId = uuid();

    const testRevokeLimit = moment().subtract(30, 'days').valueOf();
    const testEndTime = moment();

    beforeEach(() => testHelper.resetStubs(fetchRowStub, lambdaInvokeStub, momentStub));
    
    it('Redeems referral code', async () => {
        const testBoostSource = {
            bonusPoolId: 'primary_bonus_pool',
            clientId: 'some_client_id',
            floatId: 'primary_cash'
        };

        const userReferralDefaults = {
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: testBoostSource
        };

        const testReferralCodeDetails = {
            creatingUserId: testReferringUserId,
            codeType: 'USER',
            clientId: 'some_client_id',
            floatId: 'primary_cash'
        };

        momentStub.returns({ add: () => testEndTime, subtract: () => testRevokeLimit });

        fetchRowStub.onFirstCall().resolves({ countryCode: 'USA' });
        fetchRowStub.onSecondCall().resolves(testReferralCodeDetails);
        fetchRowStub.onThirdCall().resolves({ userReferralDefaults });

        lambdaInvokeStub.returns({ promise: () => ({ statusCode: 200 })});

        const testEvent = { referralCodeUsed: 'IGOTREFERRED', referredUserId: testReferredUserId };

        const resultOfCode = await handler.useReferralCode(testEvent);
        expect(resultOfCode).to.exist;

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({ resultOfTrigger: { statusCode: 200 }})
        };

        expect(resultOfCode).to.deep.equal(expectedResult);

        expect(fetchRowStub).to.have.been.calledThrice;
        expect(fetchRowStub).to.have.been.calledWithExactly('UserProfileTable', { systemWideUserId: testReferredUserId }, ['country_code']);
        expect(fetchRowStub).to.have.been.calledWithExactly('ActiveReferralCodes', { referralCode: 'IGOTREFERRED', countryCode: 'USA' }, relevantColumns);

        const referralDefaultsKey = { clientId: 'some_client_id', floatId: 'primary_cash' };
        expect(fetchRowStub).to.have.been.calledWithExactly(clientFloatTable, referralDefaultsKey, ['user_referral_defaults']);

        const expectedAudienceSelection = {
            conditions: [
                { op: 'in', prop: 'systemWideUserId', value: [testReferredUserId, testReferringUserId] }
            ]
        };

        const expectedMsgInstructions = [
            { systemWideUserId: testReferredUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' },
            { systemWideUserId: testReferringUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' }
        ];

        const expectedBoostPayload = {
            creatingUserId: testReferredUserId,
            label: `User referral code`,
            boostTypeCategory: 'REFERRAL::USER_CODE_USED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: 200000,
            boostSource: testBoostSource,
            endTimeMillis: testEndTime.valueOf(),
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: expectedAudienceSelection,
            initialStatus: 'PENDING',
            statusConditions: {
                'REDEEMED': [`save_completed_by #{${testReferredUserId}}`, `first_save_by #{${testReferredUserId}}`],
                'REVOKED': ['balance_below #{10::WHOLE_CURRENCY::ZAR}', `withdrawal_before #{${testRevokeLimit}}`]
            },
            messageInstructionFlags: { 'REDEEMED': expectedMsgInstructions }
        };

        const expectedBoostInvocation = {
            FunctionName: 'boost_create',
            InvocationType: 'Event',
            Payload: JSON.stringify(expectedBoostPayload)
        };
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedBoostInvocation);
    });

    it('Does not redeem where conditions not met', async () => {
        const testEvent = { referralCodeUsed: 'IAMREFERRED', referredUserId: testReferredUserId };

        // On invalid event
        await expect(handler.useReferralCode({ httpMethod: 'POST' })).to.eventually.deep.equal({ statusCode: 403 });

        fetchRowStub.onFirstCall().resolves({ countryCode: 'USA' });
        fetchRowStub.onSecondCall().resolves();

        // On referral code details not found
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 403 });
        fetchRowStub.reset();

        const testReferralCodeDetails = { creatingUserId: testReferringUserId, codeType: 'USER' };

        fetchRowStub.onFirstCall().resolves({ countryCode: 'USA' });
        fetchRowStub.onSecondCall().resolves(testReferralCodeDetails);

        // On missing referral code context
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 403 });
        fetchRowStub.reset();

        fetchRowStub.onFirstCall().resolves({ countryCode: 'USA' });
        fetchRowStub.onSecondCall().resolves(testReferralCodeDetails);
        fetchRowStub.onThirdCall().resolves({ userReferralDefaults: { } });

        // On zero redemption
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 200 });
    });
});
