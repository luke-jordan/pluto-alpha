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
const updateRowStub = sinon.stub();
const lambdaInvokeStub = sinon.stub();
const publishStub = sinon.stub();
const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../referral-use-handler', {
    'dynamo-common': {
        'fetchSingleRow': fetchRowStub,
        'updateRow': updateRowStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'moment': momentStub
});

const testReferralCode = 'LETMEIN';
const testBetaCode = 'ABRACADABRA';
const testCodeCases = 'Abracadabra  ';

const activeCodeTable = config.get('tables.activeCodes');
const clientFloatTable = config.get('tables.clientFloatTable');

const relevantReferralColumns = ['referralCode', 'codeType', 'expiryTimeMillis', 'context', 'clientId', 'floatId'];
const relevantProfileColumns = ['referral_code_used', 'country_code', 'creation_time_epoch_millis'];

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
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(relevantReferralColumns)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testBetaCode, countryCode: testCountryCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
    });

    it('Happy path referral code verification, case insensitive', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(relevantReferralColumns)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testCodeCases, countryCode: testCountryCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, sinon.match(relevantReferralColumns));
    });

    it('Happy path get float details as well', async () => {
        const mockReferralDefaults = { shareLink: 'https://jupitersave.com/other' };
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(relevantReferralColumns)).resolves(returnedCodeDetails);
        fetchRowStub.withArgs(clientFloatTable, { clientId: 'someClient', floatId: 'someFloat' }, ['user_referral_defaults'])
            .resolves({ userReferralDefaults: mockReferralDefaults });
        const resultOfFetch = await handler.verify({ referralCode: testCodeCases, countryCode: testCountryCode, includeFloatDefaults: true });
        const verificationBody = testHelper.standardOkayChecks(resultOfFetch);
        
        const expectedDetails = { ...returnedCodeDetails, floatDefaults: mockReferralDefaults };
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: expectedDetails });
        expect(fetchRowStub).to.have.been.calledTwice;
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, sinon.match(relevantReferralColumns));
        expect(fetchRowStub).to.have.been.calledWithExactly(clientFloatTable, { clientId: 'someClient', floatId: 'someFloat' }, ['user_referral_defaults']);
    });

    it('Happy path referral code does not exist / is not active', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: nonExistentCode }, relevantReferralColumns).resolves({ });
        const resultOfVerification = await handler.verify({ referralCode: nonExistentCode, countryCode: testCountryCode });
        const verificationBody = testHelper.expectedErrorChecks(resultOfVerification, status['Not Found']);
        expect(verificationBody).to.deep.equal({ result: 'CODE_NOT_FOUND' });
    });

    it('Referral code verification swallows errors appropriately', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: 'THISISBAD' }, relevantReferralColumns).rejects(new Error('Got that wrong!'));
        const errorThrow = await handler.verify({ referralCode: 'thisIsBad', countryCode: testCountryCode });
        expect(errorThrow).to.exist;
        expect(errorThrow).to.deep.equal({ statusCode: 500, body: JSON.stringify('Got that wrong!') });
    });

});

describe('*** UNIT TEST REFERRAL BOOST REDEMPTION ***', () => {
    const testReferringUserId = uuid();
    const testReferredUserId = uuid();

    const testProfileCreationTime = moment().valueOf();
    const testRefCodeCreationTime = moment().subtract(2, 'days').valueOf();

    const testRevokeLimit = moment().subtract(30, 'days').valueOf();
    const testEndTime = moment();

    const testBoostSource = {
        bonusPoolId: 'primary_bonus_pool',
        clientId: 'some_client_id',
        floatId: 'primary_cash'
    };

    const userReferralDefaults = {
        boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
        boostSource: testBoostSource,
        redeemConditionType: 'SIMPLE_SAVE',
        redeemConditionAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
        daysToMaintain: 30
    };

    const testReferralCodeDetails = {
        referralCode: testReferralCode,
        creatingUserId: testReferringUserId,
        persistedTimeMillis: testRefCodeCreationTime,
        codeType: 'USER',
        clientId: 'some_client_id',
        floatId: 'primary_cash',
        context: { // This context is ignored in favor of user referral defaults
            boostAmountOffered: '100::HUNDREDTH_CENT::USD',
            boostSource: { }
        }
    };

    const testBetaCodeDetails = {
        referralCode: testBetaCode,
        creatingUserId: testReferringUserId,
        persistedTimeMillis: testRefCodeCreationTime,
        codeType: 'BETA',
        clientId: 'some_client_id',
        floatId: 'primary_cash',
        context: {
            boostAmountOffered: '1000::HUNDREDTH_CENT::USD',
            boostSource: { }
        }
    };

    const testUserProfile = {
        systemWideUserId: testReferredUserId,
        countryCode: 'USA',
        creationTimeEpochMillis: testProfileCreationTime,
        referralCodeUsed: testBetaCode
    };

    beforeEach(() => testHelper.resetStubs(fetchRowStub, lambdaInvokeStub, momentStub));
    
    it('Fetches referral context and redeems boost where all conditions met', async () => {

        momentStub.onFirstCall().returns({ add: () => testEndTime });
        momentStub.onSecondCall().returns({ add: () => testRevokeLimit });

        fetchRowStub.onCall(0).resolves(testUserProfile);
        fetchRowStub.onCall(1).resolves(testReferralCodeDetails);
    
        fetchRowStub.onCall(2).resolves(testBetaCodeDetails);
        fetchRowStub.onCall(3).resolves({ userReferralDefaults });

        updateRowStub.resolves({ returnedAttributes: { referralCodeUsed: testReferralCode }});
        lambdaInvokeStub.returns({ promise: () => ({ statusCode: 200 })});

        const testEvent = { referralCodeUsed: testReferralCode, referredUserId: testReferredUserId };

        const resultOfCode = await handler.useReferralCode(testEvent);
        expect(resultOfCode).to.exist;

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({ resultOfTrigger: { statusCode: 200 }})
        };

        expect(resultOfCode).to.deep.equal(expectedResult);

        expect(fetchRowStub.callCount).to.equal(4);
        expect(fetchRowStub).to.have.been.calledWithExactly('UserProfileTable', { systemWideUserId: testReferredUserId }, relevantProfileColumns);
        expect(fetchRowStub).to.have.been.calledWithExactly('ActiveReferralCodes', { referralCode: testReferralCode, countryCode: 'USA' }, relevantReferralColumns);
        expect(fetchRowStub).to.have.been.calledWithExactly('ActiveReferralCodes', { referralCode: testBetaCode, countryCode: 'USA' }, relevantReferralColumns);

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

        const expectedStatusConditions = {
            REDEEMED: [
                `save_completed_by #{${testReferredUserId}}`, 'first_save_above #{10000::HUNDREDTH_CENT::USD}'
            ],
            REVOKED: [`withdrawal_before #{${testRevokeLimit}}`]
        };

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
            statusConditions: expectedStatusConditions,
            messageInstructionFlags: { 'REDEEMED': expectedMsgInstructions }
        };

        const expectedBoostInvocation = {
            FunctionName: 'boost_create',
            InvocationType: 'Event',
            Payload: JSON.stringify(expectedBoostPayload)
        };
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedBoostInvocation);

        const expectedProfileUpdateParams = {
            tableName: config.get('tables.userProfile'),
            itemKey: { systemWideUserId: testReferredUserId },
            updateExpression: 'set referral_code_used = :rcu',
            substitutionDict: { ':rcu': testReferralCode },
            returnOnlyUpdated: true
        };
        expect(updateRowStub).to.have.been.calledOnceWithExactly(expectedProfileUpdateParams);

        const expectedLogOptions = {
            initiator: testReferredUserId,
            context: {
                referralAmountForUser: 10, // whole currency
                referralContext: userReferralDefaults,
                referralCode: testReferralCode,
                refCodeCreationTime: testRefCodeCreationTime,
                referredUserCreationTime: testProfileCreationTime
            }
        };
        expect(publishStub).to.have.been.calledOnceWithExactly(testReferringUserId, 'REFERRAL_CODE_USED', expectedLogOptions);
    });

    it('Does not redeem where conditions not met', async () => {
        const testEvent = { referralCodeUsed: 'IAMREFERRED', referredUserId: testReferredUserId };

        // On invalid event
        await expect(handler.useReferralCode({ httpMethod: 'POST' })).to.eventually.deep.equal({ statusCode: 403 });

        fetchRowStub.onFirstCall().resolves(testUserProfile);
        fetchRowStub.onSecondCall().resolves();

        // On referral code details not found
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 400 });
        fetchRowStub.reset();

        fetchRowStub.onFirstCall().resolves(testUserProfile);
        fetchRowStub.onSecondCall().resolves(testReferralCodeDetails);
        fetchRowStub.onThirdCall().resolves(testBetaCodeDetails);

        // On missing referral code context
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 400 });
        fetchRowStub.reset();

        fetchRowStub.onCall(0).resolves(testUserProfile);
        fetchRowStub.onCall(1).resolves(testReferralCodeDetails);
    
        fetchRowStub.onCall(2).resolves(testBetaCodeDetails);
        fetchRowStub.onCall(3).resolves({ userReferralDefaults: { } });

        // On zero redemption
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 200 });
        fetchRowStub.reset();

        testReferralCodeDetails.persistedTimeMillis = moment(testRefCodeCreationTime).add(4, 'days').valueOf();

        fetchRowStub.onFirstCall().resolves(testUserProfile);
        fetchRowStub.onSecondCall().resolves(testReferralCodeDetails);
        fetchRowStub.onThirdCall().resolves({ userReferralDefaults });

        // Where used referral code is older than referred user
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 403 });
        fetchRowStub.reset();

        fetchRowStub.onCall(0).resolves(testUserProfile);
        fetchRowStub.onCall(1).resolves(testReferralCodeDetails);
    
        fetchRowStub.onCall(2).resolves(testReferralCodeDetails);
        fetchRowStub.onCall(3).resolves({ userReferralDefaults });

        // Where referral code is out of sequence
        await expect(handler.useReferralCode(testEvent)).to.eventually.deep.equal({ statusCode: 403 });
    });

});
