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

const queryStub = sinon.stub();
const fetchRowStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
    }
}

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../referral-use-handler', {
    'rds-common': MockRdsConnection,
    'dynamo-common': {
        fetchSingleRow: fetchRowStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

const testBetaCode = 'ABRACADABRA';
const testCodeCases = 'Abracadabra  ';

const activeCodeTable = config.get('tables.activeCodes');
const clientFloatTable = config.get('tables.clientFloatTable');

describe('*** UNIT TESTING VERIFY REFERRAL CODE ***', () => {

    const nonExistentCode = 'LETMEIN';
    const testCountryCode = 'RWA';

    const desiredCols = ['referralCode', 'codeType', 'expiryTimeMillis', 'context', 'clientId', 'floatId'];
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
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(desiredCols)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testBetaCode, countryCode: testCountryCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
    });

    it('Happy path referral code verification, case insensitive', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(desiredCols)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testCodeCases, countryCode: testCountryCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, sinon.match(desiredCols));
    });

    it('Happy path get float details as well', async () => {
        const mockReferralDefaults = { shareLink: 'https://jupitersave.com/other' };
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, sinon.match(desiredCols)).resolves(returnedCodeDetails);
        fetchRowStub.withArgs(clientFloatTable, { clientId: 'someClient', floatId: 'someFloat' }, ['user_referral_defaults'])
            .resolves({ userReferralDefaults: mockReferralDefaults });
        const resultOfFetch = await handler.verify({ referralCode: testCodeCases, countryCode: testCountryCode, includeFloatDefaults: true });
        const verificationBody = testHelper.standardOkayChecks(resultOfFetch);
        
        const expectedDetails = { ...returnedCodeDetails, floatDefaults: mockReferralDefaults };
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: expectedDetails });
        expect(fetchRowStub).to.have.been.calledTwice;
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, sinon.match(desiredCols));
        expect(fetchRowStub).to.have.been.calledWithExactly(clientFloatTable, { clientId: 'someClient', floatId: 'someFloat' }, ['user_referral_defaults']);
    });

    it('Happy path referral code does not exist / is not active', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: nonExistentCode }, desiredCols).resolves({ });
        const resultOfVerification = await handler.verify({ referralCode: nonExistentCode, countryCode: testCountryCode });
        const verificationBody = testHelper.expectedErrorChecks(resultOfVerification, status['Not Found']);
        expect(verificationBody).to.deep.equal({ result: 'CODE_NOT_FOUND' });
    });

    it('Referral code verification swallows errors appropriately', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: 'THISISBAD' }, desiredCols).rejects(new Error('Got that wrong!'));
        const errorThrow = await handler.verify({ referralCode: 'thisIsBad', countryCode: testCountryCode });
        expect(errorThrow).to.exist;
        expect(errorThrow).to.deep.equal({ statusCode: 500, body: JSON.stringify('Got that wrong!') });
    });

});

describe('*** UNIT TEST REFERRAL BOOST REDEMPTION ***', () => {
    const testReferringAccountId = uuid();
    const testReferredAccountId = uuid();
    const testReferringUserId = uuid();
    const testReferredUserId = uuid();

    beforeEach(() => testHelper.resetStubs(fetchRowStub, queryStub, lambdaInvokeStub));
    
    it('Redeems referral code', async () => {
        const testReferralCodeDetails = {
            context: { boostAmountOffered: '100000::HUNDREDTH_CENT::USD' },
            creatingUserId: testReferringUserId,
            codeType: 'USER'
        };

        queryStub.onFirstCall().resolves([{ 'owner_user_id': testReferredUserId }]);
        queryStub.onSecondCall().resolves([{ 'account_id': testReferringAccountId }]);

        fetchRowStub.onFirstCall().resolves({ countryCode: 'USA' });
        fetchRowStub.onSecondCall().resolves(testReferralCodeDetails);

        lambdaInvokeStub.returns({ promise: () => ({ statusCode: 200 })});

        const testEvent = { referralCodeUsed: 'IGOTREFERRED', accountIdOfReferred: testReferredAccountId };

        const resultOfCode = await handler.useReferralCode(testEvent);
        expect(resultOfCode).to.exist;

        const expectedResult = {
            statusCode: 200,
            body: JSON.stringify({
                resultOfTrigger: { statusCode: 200 }
            })
        };

        expect(resultOfCode).to.deep.equal(expectedResult);

        const userIdQuery = `select owner_user_id from account_data.core_account_ledger where account_id = $1`;
        const accountIdQuery = 'select account_id from account_data.core_account_ledger where ' +
            'owner_user_id = $1 order by creation_time desc limit 1';

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(userIdQuery, [testReferredAccountId]);
        expect(queryStub).to.have.been.calledWithExactly(accountIdQuery, [testReferringUserId]);

        expect(fetchRowStub).to.have.been.calledTwice;
        expect(fetchRowStub).to.have.been.calledWithExactly('UserProfileTable', { systemWideUserId: testReferredUserId }, ['country_code']);
        expect(fetchRowStub).to.have.been.calledWithExactly('ActiveReferralCodes', { referralCode: 'IGOTREFERRED', countryCode: 'USA' });

        expect(lambdaInvokeStub).to.have.been.calledOnce;
    });
});
