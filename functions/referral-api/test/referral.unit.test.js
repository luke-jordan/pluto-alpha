'use strict';

const logger = require('debug')('jupiter:referral:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');
const status = require('statuses');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const expect = chai.expect;
const proxyquire = require('proxyquire');

const testHelper = require('./referral.test.helper');

const momentStub = sinon.stub();
const randomStub = sinon.stub();

const fetchRowStub = sinon.stub();
const insertRowStub = sinon.stub();
const updateRowStub = sinon.stub();

const handler = proxyquire('../referral-handler', {
    'moment': momentStub,
    'random-words': randomStub,
    'dynamo-common': {
        fetchSingleRow: fetchRowStub,
        insertNewRow: insertRowStub,
        updateRow: updateRowStub
    }
});

const testBetaCode = 'ABRACADABRA';
const testCodeCases = 'Abracadabra  ';

const activeCodeTable = config.get('tables.activeCodes');
const clientFloatTable = config.get('tables.clientFloatTable');

describe('*** UNIT TESTING CREATE REFERRAL CODE ***', () => {

    const testExpiryTimeShort = moment().add(1, 'year');
    const testExpiryTimeLong = moment([2050, 0, 1]);

    const testCreatingUserId = uuid();
    const testOrdinaryUserId = uuid();
    const testPersistenceMoment = moment();

    const sampleRandomWord = 'chrysalis';

    const stdClientFloat = { floatId: 'primary_client_float', clientId: 'some_client_co' };

    // admin created / creating code
    const wellFormedRequestBody = {
        referralCode: testBetaCode,
        codeType: 'BETA',
        expiryTimeMillis: testExpiryTimeShort.valueOf(),
        creatingUserId: testCreatingUserId,
        floatId: 'primary_client_float',
        clientId: 'some_client_co',
        referralContext: {
            boostAmountOffered: '5::WHOLE_CURRENCY::USD',
            boostSource: { floatId: 'primary_client_float', clientId: 'some_client_co', bonusPoolId: 'primary_bonus_pool' }
        }
    };

    const expectedDynamoInsertionBetaCode = {
        referralCode: testBetaCode,
        codeType: 'BETA',
        persistedTimeMillis: testPersistenceMoment.valueOf(),
        expiryTimeMillis: testExpiryTimeShort.valueOf(),
        creatingUserId: testCreatingUserId,
        context: {
            clientId: 'some_client_co',
            floatId: 'primary_client_float',
            ...wellFormedRequestBody.referralContext 
        }
    };

    // user referral codes things
    const userOpeningInvocation = {
        codeType: 'USER',
        creatingUserId: testOrdinaryUserId,
        ...stdClientFloat
    };

    const userReferralDefaults = {
        boostAmountEach: '5::WHOLE_CURRENCY::USD',
        fromBonusPoolId: 'primary_bonus_pool'
    };

    const expectedDynamoInsertionUserCode = {
        referralCode: sampleRandomWord.toUpperCase().trim(),
        codeType: 'USER',
        persistedTimeMillis: testPersistenceMoment.valueOf(),
        expiryTimeMillis: testExpiryTimeLong.valueOf(),
        creatingUserId: testOrdinaryUserId,
        context: {
            ...stdClientFloat,
            boostAmountOffered: '5::WHOLE_CURRENCY::USD',
            boostSource: { ...stdClientFloat, bonusPoolId: 'primary_bonus_pool' }
        }
    };

    const expectedDynamoProfileUpdateParams = {
        tableName: config.get('tables.userProfile'),
        itemKey: { systemWideUserId: testOrdinaryUserId },
        updateExpression: 'set referral_code = :rc',
        substitutionDict: { ':rc': sampleRandomWord.toUpperCase().trim() },
        returnOnlyUpdated: true
    };

    beforeEach(() => testHelper.resetStubs(fetchRowStub, insertRowStub, updateRowStub, randomStub));

    it('Happy path referral code creation, beta code', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: testBetaCode }, ['referralCode']).resolves({});
        insertRowStub.resolves({ result: 'SUCCESS' });
        momentStub.returns(testPersistenceMoment);

        const resultOfCall = await handler.create(wellFormedRequestBody);
        logger('Result of referral creation: ', resultOfCall);

        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);
        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        
        expect(insertRowStub).to.have.been.calledWithExactly(activeCodeTable, ['referralCode'], expectedDynamoInsertionBetaCode);
    });

    it('Happy path referral code creation, user code, no word conflict', async () => {
        randomStub.returns(sampleRandomWord);
        fetchRowStub.withArgs(clientFloatTable, stdClientFloat).resolves({ userReferralDefaults });
        fetchRowStub.withArgs(activeCodeTable, { referralCode: sampleRandomWord.toUpperCase() }, ['referralCode']).resolves({});
        
        momentStub.withArgs().returns(testPersistenceMoment);
        momentStub.withArgs([2050, 0, 1]).returns(testExpiryTimeLong);

        insertRowStub.resolves({ result: 'SUCCESS' });
        updateRowStub.withArgs(expectedDynamoProfileUpdateParams).resolves({ referralCode: sampleRandomWord.toUpperCase() });
        
        logger('Expecting: ', expectedDynamoInsertionUserCode);
        const resultOfCall = await handler.create(userOpeningInvocation);

        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);
        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        
        expect(insertRowStub).to.have.been.calledOnceWith(activeCodeTable, ['referralCode'], expectedDynamoInsertionUserCode);
        expect(updateRowStub).to.have.been.calledOnceWith(expectedDynamoProfileUpdateParams);

    });

    it('Happy path referral code creation, user code, handles initial word conflict', async () => {
        randomStub.onFirstCall().returns('takenWord');
        fetchRowStub.withArgs(activeCodeTable, { referralCode: 'TAKENWORD' }, ['referralCode']).resolves({ referralCode: 'TAKENWORD' });
        randomStub.onSecondCall().returns(sampleRandomWord);
        fetchRowStub.withArgs(activeCodeTable, { referralCode: sampleRandomWord }, ['referralCode']).resolves({});
        
        momentStub.withArgs().returns(testPersistenceMoment);
        momentStub.withArgs([2050, 0, 1]).returns(testExpiryTimeLong);

        fetchRowStub.withArgs(clientFloatTable, stdClientFloat).resolves({ userReferralDefaults });
        insertRowStub.withArgs(activeCodeTable, ['referralCode'], expectedDynamoInsertionUserCode).resolves({ result: 'SUCCESS' });
        updateRowStub.withArgs(expectedDynamoProfileUpdateParams).resolves({ referralCode: sampleRandomWord.toUpperCase() });

        const resultOfCall = await handler.create(userOpeningInvocation);
        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);

        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        expect(fetchRowStub).to.have.been.calledThrice;
        expect(insertRowStub).to.have.been.calledOnce;
        expect(updateRowStub).to.have.been.calledOnceWith(expectedDynamoProfileUpdateParams);
    });

    it('Handles case changes and whitespace properly', async () => {
        const otherCaseReqBody = JSON.parse(JSON.stringify(wellFormedRequestBody));
        otherCaseReqBody.referralCode = testCodeCases;

        // since we assume upper case insertion, we leave this as above
        fetchRowStub.withArgs(activeCodeTable, { referralCode: testBetaCode }, ['referralCode']).resolves({});
        insertRowStub.withArgs(activeCodeTable, ['referralCode'], expectedDynamoInsertionBetaCode).resolves({ result: 'SUCCESS' });
        momentStub.returns(testPersistenceMoment);

        const resultOfCall = await handler.create(otherCaseReqBody);
        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);
        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        expect(fetchRowStub).to.have.been.calledOnceWithExactly(activeCodeTable, { referralCode: testBetaCode }, ['referralCode']);
        expect(insertRowStub).to.has.been.calledOnceWithExactly(activeCodeTable, ['referralCode'], expectedDynamoInsertionBetaCode);
    });

    it('Throws error if active code already exists', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: testBetaCode }, ['referralCode']).resolves({ referralCode: testBetaCode });
        const resultOfCall = await handler.create(wellFormedRequestBody);
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: status['Conflict'], body: JSON.stringify({ result: 'CODE_ALREADY_EXISTS' })});
    });

    it('Handles insertion error properly', async () => {
        const triggeringCall1 = JSON.parse(JSON.stringify(wellFormedRequestBody));
        triggeringCall1.referralCode = 'mysteriousError';
        
        momentStub.returns(testPersistenceMoment);
        insertRowStub.resolves({ result: 'ERROR', message: 'UNKNOWN' });
        
        const triggeredError1 = await handler.create(triggeringCall1);
        expect(triggeredError1).to.exist;
        expect(triggeredError1).to.deep.equal({ statusCode: 500, body: JSON.stringify('Unknown error, check logs for insertion error') });
    });

    it('Swallows error throws appropriately', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: 'NASTYLOUSYCODE'}, ['referralCode']).rejects(new Error('Something weird happened'));
        const triggeringCall2 = JSON.parse(JSON.stringify(wellFormedRequestBody));
        triggeringCall2.referralCode = 'nastyLousyCode';
        const triggeredError2 = await handler.create(triggeringCall2);
        expect(triggeredError2).to.exist;
        expect(triggeredError2).to.deep.equal({ statusCode: 500, body: JSON.stringify('Something weird happened') });
    });

});

describe('*** UNIT TESTING VERIFY REFERRAL CODE ***', () => {

    const nonExistentCode = 'LETMEIN';

    const desiredCols = ['referralCode', 'codeType', 'expiryTimeMillis', 'context'];
    const returnedCodeDetails = {
        referralCode: testBetaCode,
        codeType: 'BETA',
        expiryTimeMillis: moment().add(1, 'month').valueOf(),
        context: {
            openingBonus: {
                'amount': '5',
                'currency': 'USD',
                'unit': 'WHOLE_CURRENCY'
            }
        }
    };

    beforeEach(() => testHelper.resetStubs(fetchRowStub, insertRowStub, updateRowStub));

    it('Warms up referral verify lambda', async () => {
        const mockEvent = { warmupCall: true };

        const result = await handler.verify(mockEvent);
        logger('Result of warm up call to lambda:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(400);
        expect(result).to.have.property('body');
        expect(result.body).to.deep.equal('Empty invocation');
    });

    it('Happy path referral code verification, when it exists, normal body', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: testBetaCode }, sinon.match(desiredCols)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testBetaCode });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
    });

    it('Happy path referral code verification, case insensitive', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: testBetaCode }, sinon.match(desiredCols)).resolves(returnedCodeDetails);
        const resultOfVerification = await handler.verify({ referralCode: testCodeCases });
        const verificationBody = testHelper.standardOkayChecks(resultOfVerification);
        expect(verificationBody).to.deep.equal({ result: 'CODE_IS_ACTIVE', codeDetails: returnedCodeDetails });
        expect(fetchRowStub).to.have.been.calledWithExactly(activeCodeTable, { referralCode: testBetaCode }, sinon.match(desiredCols));
    });

    it('Happy path referral code does not exist / is not active', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: nonExistentCode }, desiredCols).resolves({ });
        const resultOfVerification = await handler.verify({ referralCode: nonExistentCode });
        const verificationBody = testHelper.expectedErrorChecks(resultOfVerification, status['Not Found']);
        expect(verificationBody).to.deep.equal({ result: 'CODE_NOT_FOUND' });
    });

    it('Referral code verification swallows errors appropriately', async () => {
        fetchRowStub.withArgs(activeCodeTable, { referralCode: 'THISISBAD' }, desiredCols).rejects(new Error('Got that wrong!'));
        const errorThrow = await handler.verify({ referralCode: 'thisIsBad' });
        expect(errorThrow).to.exist;
        expect(errorThrow).to.deep.equal({ statusCode: 500, body: JSON.stringify('Got that wrong!') });
    });

});
