'use strict';

const logger = require('debug')('jupiter:boosts:admin-test');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const listBoostsStub = sinon.stub();
const updateBoostStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-admin-handler', {
    './persistence/rds.admin.boost': {
        'listBoosts': listBoostsStub,
        'updateBoost': updateBoostStub
    },
    '@noCallThru': true
});

const wrapEvent = (requestBody, systemWideUserId, role) => ({
    body: JSON.stringify(requestBody),
    requestContext: {
        authorizer: {
            systemWideUserId,
            role
        }
    }
});

const wrapQueryParamEvent = (requestBody, systemWideUserId, role) => ({
    queryStringParameters: requestBody,
    requestContext: {
        authorizer: {
            systemWideUserId,
            role
        }
    }
});

const resetStubs = () => testHelper.resetStubs(updateBoostStub, listBoostsStub);

describe('*** UNIT TEST BOOST ADMIN FUNCTIONS ***', () => {
    const testUserId = uuid();
    const testBoostId = uuid();
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };

    const testBoostStartTime = moment();
    const testBoostEndTime = moment();
    const testUpdatedTime = moment().format();

    const testInstructionId = uuid();
    const testCreatingUserId = uuid();
    const testReferringAccountId = uuid();
    const testReferredUserAccountId = uuid();

    const persistedBoost = {
        boostId: testBoostId,
        creatingUserId: testCreatingUserId,
        label: 'Referral::Luke::Avish',
        startTime: testBoostStartTime.format(),
        endTime: testBoostEndTime.format(),
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_float',
        forClientId: 'some_client_co',
        boostAudience: 'INDIVIDUAL',
        audienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
        statusConditions: testStatusCondition,
        messageInstructionIds: { instructions: [testInstructionId, testInstructionId] },
        conditionValues: ['TEST_VALUE'],
        flags: ['TEST_FLAG']
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Lists boosts', async () => {
        listBoostsStub.resolves([persistedBoost]);

        const passedParameters = {
            includeReferrals: true,
            includeUserCounts: true,
            includeExpired: true,
            includeStatusCounts: true
        };

        const expectedEvent = wrapQueryParamEvent(passedParameters, testUserId, 'SYSTEM_ADMIN');
        logger('Created event:', expectedEvent);

        const resultOfListing = await handler.listBoosts(expectedEvent);
        logger('Result of boost listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify([persistedBoost]));
        expect(listBoostsStub).to.have.been.calledOnceWithExactly([], true, true);
    });

    it('Sets default type categories for exclusion', async () => {
        listBoostsStub.resolves([persistedBoost]);

        const expectedBody = { includeUserCounts: true, includeExpired: true, includeStatusCounts: true };
        const expectedEvent = wrapQueryParamEvent(expectedBody, testUserId, 'SYSTEM_ADMIN');
        logger('Created event:', expectedEvent);

        const resultOfListing = await handler.listBoosts(expectedEvent);
        logger('Result of boost listing:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify([persistedBoost]));
        expect(listBoostsStub).to.have.been.calledOnceWithExactly(['REFERRAL::USER_CODE_USED', 'REFERRAL::BETA_CODE_USED'], true, true);
    });

    it('Fails on missing authorization', async () => {
        const expectedBody = { includeReferrals: true, includeUserCounts: true, includeExpired: true };
        const resultOfListing = await handler.listBoosts(expectedBody);
        logger('Result of boost listing:', resultOfListing);
        expect(resultOfListing).to.exist;
        expect(resultOfListing.statusCode).to.deep.equal(403);
        expect(resultOfListing.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(listBoostsStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        listBoostsStub.throws(new Error('PersistenceError'));

        const expectedBody = { includeReferrals: true, includeUserCounts: true, includeExpired: true };
        const expectedEvent = wrapQueryParamEvent(expectedBody, testUserId, 'SYSTEM_ADMIN');
        logger('Created event:', expectedEvent);

        const resultOfListing = await handler.listBoosts(expectedEvent);
        logger('Result of boost listing:', resultOfListing);
        expect(resultOfListing).to.exist;
        expect(resultOfListing.statusCode).to.deep.equal(500);
        expect(resultOfListing.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify('PersistenceError'));
        expect(listBoostsStub).to.have.been.calledOnce;
    });

    // ///////////////////////////////////////////////////////////////////////////////////////
    // //////////////////////////// UPDATE INSTRUCTION TESTS /////////////////////////////////
    // ///////////////////////////////////////////////////////////////////////////////////////

    it('Updates boost instruction', async () => {
        const expectedEventBody = { boostId: testBoostId, boostStatus: 'OFFERED' };
        updateBoostStub.withArgs(expectedEventBody).resolves([{ updatedTime: testUpdatedTime }]);

        const expectedEvent = wrapEvent(expectedEventBody, testUserId, 'SYSTEM_ADMIN');
        const resultOfUpdate = await handler.updateInstruction(expectedEvent);
        logger('Result of boost update:', resultOfUpdate);
        logger('args:', updateBoostStub.getCall(0).args);
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate.statusCode).to.deep.equal(200);
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfUpdate.body).to.deep.equal(JSON.stringify([{ updatedTime: testUpdatedTime }]));
        expect(updateBoostStub).to.have.been.calledOnceWithExactly(expectedEventBody);
    });

    it('Fails on missing authorization', async () => {
        const resultOfUpdate = await handler.updateInstruction({});
        logger('Result of boost update:', resultOfUpdate);
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate.statusCode).to.deep.equal(403);
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(updateBoostStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        updateBoostStub.throws(new Error('PersistenceError'));

        const expectedEvent = wrapEvent({}, testUserId, 'SYSTEM_ADMIN');
        const resultOfUpdate = await handler.updateInstruction(expectedEvent);
        logger('Result of boost update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate.statusCode).to.deep.equal(500);
        expect(resultOfUpdate.headers).to.deep.equal(testHelper.expectedHeaders);
        expect(resultOfUpdate.body).to.deep.equal(JSON.stringify('PersistenceError'));
        expect(updateBoostStub).to.have.been.calledOnce;
    });
});
