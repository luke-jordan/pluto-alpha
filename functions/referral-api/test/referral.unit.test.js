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
const deleteRowStub = sinon.stub();

const handler = proxyquire('../referral-handler', {
    'moment': momentStub,
    'random-words': randomStub,
    'dynamo-common': {
        fetchSingleRow: fetchRowStub,
        insertNewRow: insertRowStub,
        updateRow: updateRowStub,
        deleteRow: deleteRowStub,
        '@noCallThru': true
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

    const testCountryCode = 'RWA';
    const stdCountryClientFloat = { floatId: 'primary_client_float', clientId: 'some_client_co', countryCode: testCountryCode };

    // admin created / creating code
    const wellFormedRequestBody = {
        countryCode: testCountryCode,
        referralCode: testBetaCode,
        codeType: 'BETA',
        expiryTimeMillis: testExpiryTimeShort.valueOf(),
        creatingUserId: testCreatingUserId,
        floatId: 'primary_client_float',
        clientId: 'some_client_co',
        referralContext: {
            boostAmountOffered: '5::WHOLE_CURRENCY::USD',
            bonusPoolId: 'primary_bonus_pool'
        },
        tags: ['TAGGED!', 'TWICE']
    };

    const expectedDynamoInsertionBetaCode = {
        countryCode: testCountryCode,
        referralCode: testBetaCode,
        codeType: 'BETA',
        clientId: 'some_client_co',
        floatId: 'primary_client_float',
        clientIdFloatId: 'some_client_co::primary_client_float',
        persistedTimeMillis: testPersistenceMoment.valueOf(),
        expiryTimeMillis: testExpiryTimeShort.valueOf(),
        creatingUserId: testCreatingUserId,
        context: wellFormedRequestBody.referralContext,
        tags: ['TAGGED!', 'TWICE']
    };

    // user referral codes things
    const userOpeningInvocation = {
        codeType: 'USER',
        creatingUserId: testOrdinaryUserId,
        ...stdCountryClientFloat
    };

    const userReferralDefaults = {
        boostAmountEach: '5::WHOLE_CURRENCY::USD',
        fromBonusPoolId: 'primary_bonus_pool',
        shareLink: 'https://jupitersave.com'
    };

    const expectedDynamoInsertionUserCode = (referralCode = sampleRandomWord.toUpperCase().trim()) => ({
        referralCode,
        codeType: 'USER',
        persistedTimeMillis: testPersistenceMoment.valueOf(),
        expiryTimeMillis: testExpiryTimeLong.valueOf(),
        creatingUserId: testOrdinaryUserId,
        ...stdCountryClientFloat,
        clientIdFloatId: 'some_client_co::primary_client_float',
        context: {
            boostAmountOffered: '5::WHOLE_CURRENCY::USD',
            bonusPoolId: 'primary_bonus_pool',
            shareLink: 'https://jupitersave.com'
        }
    });

    const expectedDynamoProfileUpdateParams = (referralCode = sampleRandomWord.toUpperCase().trim()) => ({
        tableName: config.get('tables.userProfile'),
        itemKey: { systemWideUserId: testOrdinaryUserId },
        updateExpression: 'set referral_code = :rc',
        substitutionDict: { ':rc': referralCode },
        returnOnlyUpdated: true
    });

    beforeEach(() => testHelper.resetStubs(fetchRowStub, insertRowStub, updateRowStub, randomStub));

    it('Happy path referral code creation, beta code', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, ['referralCode']).resolves({});
        insertRowStub.resolves({ result: 'SUCCESS' });
        momentStub.returns(testPersistenceMoment);

        const resultOfCall = await handler.create(wellFormedRequestBody);
        logger('Result of referral creation: ', resultOfCall);

        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);
        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        expect(insertRowStub).to.have.been.calledWithExactly(activeCodeTable, ['referralCode'], expectedDynamoInsertionBetaCode);
    });

    it('Happy path referral code creation, user code, no word conflict', async () => {
        randomStub.returns('THISRANDOMWORD');

        const { clientId, floatId } = stdCountryClientFloat;
        fetchRowStub.withArgs(clientFloatTable, { clientId, floatId }).resolves({ userReferralDefaults });
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: sampleRandomWord.toUpperCase() }, ['referralCode']).resolves({});
        
        momentStub.withArgs().returns(testPersistenceMoment);
        momentStub.withArgs([2050, 0, 1]).returns(testExpiryTimeLong);

        insertRowStub.resolves({ result: 'SUCCESS' });
        updateRowStub.withArgs(expectedDynamoProfileUpdateParams).resolves({ referralCode: sampleRandomWord.toUpperCase() });
        
        const resultOfCall = await handler.create(userOpeningInvocation);

        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);
        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        
        // logger('Expected: ', expectedDynamoInsertionUserCode);
        // logger('Called:', insertRowStub.getCall(0).args[2]);

        const expectedReferralCode = `THISRANDOMWORD${moment().format('DD')}`;
        expect(insertRowStub).to.have.been.calledOnceWith(activeCodeTable, ['referralCode'], expectedDynamoInsertionUserCode(expectedReferralCode));
        expect(updateRowStub).to.have.been.calledOnceWith(expectedDynamoProfileUpdateParams(expectedReferralCode));
    });

    it('Happy path referral code creation, user code, handles initial word conflict', async () => {
        randomStub.onFirstCall().returns('takenWord');

        const daySuffix = moment().format('DD');
        const acceptableCode = `${sampleRandomWord.toUpperCase().trim()}${daySuffix}`;
        
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: `TAKENWORD${daySuffix}` }, ['referralCode']).resolves({ referralCode: 'TAKENWORD' });
        randomStub.onSecondCall().returns(sampleRandomWord);
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: acceptableCode }, ['referralCode']).resolves({});
        
        momentStub.withArgs().returns(testPersistenceMoment);
        momentStub.withArgs([2050, 0, 1]).returns(testExpiryTimeLong);

        const { clientId, floatId } = stdCountryClientFloat;
        fetchRowStub.withArgs(clientFloatTable, { clientId, floatId }).resolves({ userReferralDefaults });
        
        insertRowStub.resolves({ result: 'SUCCESS' });
        updateRowStub.resolves({ referralCode: sampleRandomWord.toUpperCase() });

        const resultOfCall = await handler.create(userOpeningInvocation);
        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);

        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        expect(fetchRowStub).to.have.been.calledThrice;

        const expectedInsertArg = expectedDynamoInsertionUserCode(acceptableCode);
        const expectedUpdateArg = expectedDynamoProfileUpdateParams(acceptableCode);

        expect(insertRowStub).to.have.been.calledOnceWith(activeCodeTable, ['referralCode'], expectedInsertArg);
        expect(updateRowStub).to.have.been.calledOnceWith(expectedUpdateArg);
    });

    it('Handles case changes and whitespace properly', async () => {
        const otherCaseReqBody = { ...wellFormedRequestBody };
        otherCaseReqBody.referralCode = testCodeCases;

        // since we assume upper case insertion, we leave this as above
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, ['referralCode']).resolves({});
        insertRowStub.withArgs(activeCodeTable, ['referralCode'], expectedDynamoInsertionBetaCode).resolves({ result: 'SUCCESS' });
        momentStub.returns(testPersistenceMoment);

        const resultOfCall = await handler.create(otherCaseReqBody);
        const bodyOfResult = testHelper.standardOkayChecks(resultOfCall);
        expect(bodyOfResult).to.deep.equal({ persistedTimeMillis: testPersistenceMoment.valueOf() });
        expect(fetchRowStub).to.have.been.calledOnceWithExactly(activeCodeTable, { referralCode: testBetaCode, countryCode: testCountryCode }, ['referralCode']);
        expect(insertRowStub).to.has.been.calledOnceWithExactly(activeCodeTable, ['referralCode'], expectedDynamoInsertionBetaCode);
    });

    it('Throws error if active code already exists', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: testCountryCode, referralCode: testBetaCode }, ['referralCode']).resolves({ referralCode: testBetaCode });
        const resultOfCall = await handler.create(wellFormedRequestBody);
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: status['Conflict'], body: JSON.stringify({ result: 'CODE_ALREADY_EXISTS' })});
    });

    it('Handles insertion error properly', async () => {
        const triggeringCall1 = { ...wellFormedRequestBody };
        triggeringCall1.referralCode = 'mysteriousError';
        
        momentStub.returns(testPersistenceMoment);
        insertRowStub.resolves({ result: 'ERROR', message: 'UNKNOWN' });
        
        const triggeredError1 = await handler.create(triggeringCall1);
        expect(triggeredError1).to.exist;
        expect(triggeredError1).to.deep.equal({ statusCode: 500, body: JSON.stringify('Unknown error, check logs for insertion error') });
    });

    it('Swallows error throws appropriately', async () => {
        fetchRowStub.withArgs(activeCodeTable, { countryCode: 'BAD', referralCode: 'NASTYLOUSYCODE'}, ['referralCode']).rejects(new Error('Something weird happened'));
        const triggeringCall2 = { ...wellFormedRequestBody };
        triggeringCall2.referralCode = 'nastyLousyCode';
        triggeringCall2.countryCode = 'BAD';
        const triggeredError2 = await handler.create(triggeringCall2);
        expect(triggeredError2).to.exist;
        expect(triggeredError2).to.deep.equal({ statusCode: 500, body: JSON.stringify('Something weird happened') });
    });

});

// todo : error testing, validation testing (& handling of those in handler)
describe('*** UNIT TESTING MODIFY REFERRAL CODE ***', () => {
    
    const testCode = 'LETMEIN';
    const testCountryCode = 'RWA';

    beforeEach(() => testHelper.resetStubs(fetchRowStub, insertRowStub, updateRowStub, momentStub));

    it('Deactivate a referral code appropriately', async () => {
        const testMoment = moment();
        const testAdminId = uuid();

        const inboundEvent = {
            operation: 'DEACTIVATE',
            countryCode: testCountryCode,
            referralCode: testCode,
            initiator: testAdminId
        };

        const oldCode = {
            countryCode: testCountryCode,
            referralCode: testCode,
            clientId: 'some-client',
            floatId: 'some-float',
            context: { boostSource: 'none' }
        };

        const expectedArchiveInsert = {
            referralCode: testCode,
            deactivatedTime: testMoment.valueOf(),
            countryCode: testCountryCode,
            deactivatingUserId: testAdminId, 
            archivedCode: oldCode 
        };

        const expectedDelete = {
            tableName: activeCodeTable,
            itemKey: { countryCode: testCountryCode, referralCode: testCode }
        };

        momentStub.returns(testMoment);
        fetchRowStub.resolves(oldCode);
        insertRowStub.resolves({ result: 'SUCCESS' });
        deleteRowStub.resolves({ result: 'DELETED' });

        const resultOfDeactivate = await handler.modify(inboundEvent);
        expect(resultOfDeactivate).to.deep.equal({ result: 'DEACTIVATED' });

        expect(fetchRowStub).to.have.been.calledOnceWithExactly(activeCodeTable, { countryCode: testCountryCode, referralCode: testCode });
        expect(insertRowStub).to.have.been.calledOnceWithExactly(config.get('tables.archivedCodes'), ['referralCode', 'deactivatedTime'], expectedArchiveInsert);
        expect(deleteRowStub).to.have.been.calledOnceWithExactly(expectedDelete);
    });

    it('Modify a referral code, just the field that changed', async () => {
            const inboundEvent = {
            operation: 'UPDATE',
            countryCode: testCountryCode,
            referralCode: testCode,
            newContext: {
                boostAmountOffered: '1000000::HUNDREDTH_CENT::USD'
            },
            tags: ['TAGGEDONCE']
        };

        const expectedUpdate = {
            tableName: activeCodeTable,
            itemKey: { countryCode: testCountryCode, referralCode: testCode },
            updateExpression: 'set context.boostAmountOffered = :bamount, tags = :rts',
            substitutionDict: { ':bamount': '1000000::HUNDREDTH_CENT::USD', ':rts': ['TAGGEDONCE'] },
            returnOnlyUpdated: false
        };

        updateRowStub.resolves({ result: 'SUCCESS', returnedAttributes: {
            newContext: { boostAmountOffered: '1000000::HUNDREDTH_CENT::USD' },
            tags: ['TAGGEDONCE']
        }});

        const resultOfUpdate = await handler.modify(inboundEvent);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('result', 'UPDATED');
        expect(resultOfUpdate).to.have.property('updatedCode');
        expect(resultOfUpdate.updatedCode.tags).to.deep.equal(['TAGGEDONCE']);

        expect(updateRowStub).to.have.been.calledOnceWithExactly(expectedUpdate);
    });

});
