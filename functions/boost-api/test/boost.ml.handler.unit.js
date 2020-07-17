'use strict';

// const logger = require('debug')('jupiter:boosts:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const proxyquire = require('proxyquire').noCallThru();

const tinyPostStub = sinon.stub();
const findUserIdsStub = sinon.stub();
const updateStatusStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const findBoostLogStub = sinon.stub();
const fetchMlBoostsStub = sinon.stub();
const fetchAudienceStub = sinon.stub();
const accountStatusStub = sinon.stub();
const extractAccountIdsStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../boost-ml-handler', {
    './persistence/rds.boost': {
        'fetchBoostAccountStatuses': accountStatusStub,
        'updateBoostAccountStatus': updateStatusStub,
        'extractAccountIds': extractAccountIdsStub,
        'findUserIdsForAccounts': findUserIdsStub,
        'fetchActiveMlBoosts': fetchMlBoostsStub,
        'findLastLogForBoost': findBoostLogStub,
        'fetchBoostAudience': fetchAudienceStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'tiny-json-http': {
        'post': tinyPostStub,
        '@noCallThru': true
    },
    '@noCallThru': true
});

describe('*** UNIT TEST BOOST ML HANDLER ***', () => {
    const testStartTime = moment();
    const testEndTime = moment().add(3, 'months');

    const testCreationTime = moment().subtract(31, 'days').format();
    const testUpdatedTime = moment().format();

    const testLogId = uuid();
    const testBoostId = uuid();
    const testAudienceId = uuid();
    const testInstructionId = uuid();
  
    const testCreatingUserId = uuid();

    const mockMlBoostFromRds = (mlParameters) => ({
        boostId: testBoostId,
        creatingUserId: testCreatingUserId,
        label: 'Midweek Catch Arrow',
        boostType: 'GAME',
        boostCategory: 'CHASE_ARROW',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        boostAudienceType: 'GENERAL',
        audienceId: testAudienceId,
        defaultStatus: 'CREATED',
        messageInstructionIds: { instructions: [{ instructionId: testInstructionId }]},
        mlParameters
    });

    const mockBoostAccountStatus = (accountId, boostStatus) => ({
        boostId: testBoostId,
        accountId,
        boostStatus
    });

    beforeEach(() => helper.resetStubs(fetchMlBoostsStub, fetchAudienceStub, updateStatusStub, accountStatusStub, extractAccountIdsStub,
        findUserIdsStub, tinyPostStub, findBoostLogStub, lamdbaInvokeStub));

    it('Handles ml boost that are only offered once', async () => {
        const mockAccountIds = ['account-id-1', 'account-id-2'];
        
        const firstAccStatus = mockBoostAccountStatus('account-id-1', 'CREATED');
        const secondAccStatus = mockBoostAccountStatus('account-id-2', 'OFFERED');

        const mlParameters = { onlyOfferOnce: true, maxPortionOfAudience: 0.2 };

        const tinyOptions = {
            url: config.get('mlSelection.endpoint'),
            data: {
                'boost_parameters': { 'boost_amount_whole_currency': 10, 'boost_type_category': 'GAME::CHASE_ARROW' },
                'candidate_users': ['user-id-1']
            }
        };

        const audiencePayload = { operation: 'refresh', params: { audienceId: testAudienceId }};
        const audienceInvocation = helper.wrapLambdaInvoc('audience_selection', false, audiencePayload);

        const msgInstruction = { destinationUserId: 'user-id-1', instructionId: testInstructionId, parameters: mockMlBoostFromRds(mlParameters) };
        const msgInvocation = helper.wrapLambdaInvoc('message_user_create_once', true, { instructions: [msgInstruction] });

        const expectedStatusUpdateInstruction = {
            boostId: testBoostId,
            accountIds: ['account-id-1'],
            newStatus: 'OFFERED',
            logType: 'ML_BOOST_OFFERED'
        };

        fetchMlBoostsStub.resolves([mockMlBoostFromRds(mlParameters)]);
        extractAccountIdsStub.resolves(mockAccountIds);
        accountStatusStub.resolves([firstAccStatus, secondAccStatus]);
        findUserIdsStub.resolves({ 'user-id-1': 'account-id-1' });

        tinyPostStub.resolves([{ 'user_id': 'user-id-1', 'should_offer': true }]);

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 200 })});

        updateStatusStub.resolves([{ boostId: testBoostId, updatedTime: testUpdatedTime }]);
        
        const resultOfBoost = await handler.processMlBoosts({});

        expect(resultOfBoost).to.exist;
        expect(resultOfBoost).to.deep.equal({ result: 'SUCCESS' });
        
        expect(fetchMlBoostsStub).to.have.been.calledOnceWithExactly();
        expect(accountStatusStub).to.have.been.calledOnceWithExactly(testBoostId, ['account-id-1', 'account-id-2']);
        
        expect(tinyPostStub).to.have.been.calledOnceWithExactly(tinyOptions);
        
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(audienceInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(msgInvocation);
        
        expect(extractAccountIdsStub).to.have.been.calledOnceWithExactly(testAudienceId);
        expect(updateStatusStub).to.have.been.calledOnceWithExactly([expectedStatusUpdateInstruction]);
        expect(findBoostLogStub).to.have.not.been.called;
    });

    it('Handles recurring machine determined boost offerings', async () => {
        const mlParameters = { onlyOfferOnce: false, minIntervalBetweenRuns: { unit: 'days', value: 30 }};
        const mockAccountIds = ['account-id-1', 'account-id-2'];

        const tinyOptions = {
            url: config.get('mlSelection.endpoint'),
            data: {
                'boost_parameters': { 'boost_amount_whole_currency': 10, 'boost_type_category': 'GAME::CHASE_ARROW' },
                'candidate_users': ['user-id-1', 'user-id-2']
            }
        };

        const expectedStatusUpdateInstruction = {
            boostId: testBoostId,
            accountIds: ['account-id-1'],
            newStatus: 'OFFERED',
            logType: 'ML_BOOST_OFFERED'
        };

        const audiencePayload = { operation: 'refresh', params: { audienceId: testAudienceId }};
        const audienceInvocation = helper.wrapLambdaInvoc('audience_selection', false, audiencePayload);

        const msgInstruction = { destinationUserId: 'user-id-1', instructionId: testInstructionId, parameters: mockMlBoostFromRds(mlParameters) };
        const msgInvocation = helper.wrapLambdaInvoc('message_user_create_once', true, { instructions: [msgInstruction] });

        const mockBoostLog = (accountId) => ({
            logId: testLogId,
            creationTime: testCreationTime,
            boostId: testBoostId,
            accountId,
            logType: 'ML_BOOST_OFFERED'
        });

        fetchMlBoostsStub.resolves([mockMlBoostFromRds(mlParameters)]);
        extractAccountIdsStub.resolves(mockAccountIds);
        findUserIdsStub.resolves({ 'user-id-1': 'account-id-1', 'user-id-2': 'account-id-2' });
        
        tinyPostStub.resolves([{ 'user_id': 'user-id-1', 'should_offer': true }, { 'user_id': 'user-id-2', 'should_offer': false }]);

        lamdbaInvokeStub.returns({ promise: () => ({ StatusCode: 200 }) });

        updateStatusStub.resolves([{ boostId: testBoostId, updatedTime: testUpdatedTime }]);
        findBoostLogStub.onFirstCall().resolves(mockBoostLog('account-id-1'));
        findBoostLogStub.onSecondCall().resolves(mockBoostLog('account-id-2'));

        const resultOfBoost = await handler.processMlBoosts({});

        expect(resultOfBoost).to.exist;
        expect(resultOfBoost).to.deep.equal({ result: 'SUCCESS' });


        expect(fetchMlBoostsStub).to.have.been.calledOnceWithExactly();
        expect(extractAccountIdsStub).to.have.been.calledOnceWithExactly(testAudienceId);
        
        expect(accountStatusStub).to.have.not.been.called;
        expect(findBoostLogStub.callCount).to.equal(2);
        mockAccountIds.map((accountId) => expect(findBoostLogStub).to.have.been.calledWithExactly(testBoostId, accountId, 'ML_BOOST_OFFERED'));
        
        expect(tinyPostStub).to.have.been.calledOnceWithExactly(tinyOptions);
        
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(audienceInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(msgInvocation);
        
        expect(updateStatusStub).to.have.been.calledOnceWithExactly([expectedStatusUpdateInstruction]);
    });
});
