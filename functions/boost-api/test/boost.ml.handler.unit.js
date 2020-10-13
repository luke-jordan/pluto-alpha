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
const lambdaInvokeStub = sinon.stub();
const findBoostLogStub = sinon.stub();
const fetchMlBoostsStub = sinon.stub();
const fetchAudienceStub = sinon.stub();
const accountStatusStub = sinon.stub();
const extractAccountIdsStub = sinon.stub();

const publishEventStub = sinon.stub();
const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../boost-ml-handler', {
    './persistence/rds.boost': {
        'findAccountsForBoost': accountStatusStub,
        'updateBoostAccountStatus': updateStatusStub,
        'extractAccountIds': extractAccountIdsStub,
        'findUserIdsForAccounts': findUserIdsStub,
        'fetchActiveMlBoosts': fetchMlBoostsStub,
        'findLastLogForBoost': findBoostLogStub,
        'fetchBoostAudience': fetchAudienceStub
    },
    'publish-common': {
        'publishMultiUserEvent': publishEventStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'tiny-json-http': {
        'post': tinyPostStub,
        '@noCallThru': true
    },
    'moment': momentStub,
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
        messageInstructions: [{ msgInstructionId: testInstructionId, status: 'OFFERED', accountId: 'ALL' }],
        expiryParameters: {
            individualizedExpiry: true,
            timeUntilExpiry: { unit: 'hours', value: 24 }
        },
        mlParameters
    });

    beforeEach(() => helper.resetStubs(fetchMlBoostsStub, fetchAudienceStub, updateStatusStub, accountStatusStub, extractAccountIdsStub,
        findUserIdsStub, tinyPostStub, findBoostLogStub, lambdaInvokeStub, publishEventStub));

    it('Handles ml boost that are only offered once', async () => {
        const mockAccountIds = ['account-id-1', 'account-id-2'];
        
        const mockAccountUserMap = {
            'account-id-1': { status: 'CREATED', userId: 'user-id-1' },
            'account-id-2': { status: 'OFFERED', userId: 'user-id-2' }
        };

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

        const mockMoment = moment();
        const expectedStatusUpdateInstruction = {
            boostId: testBoostId,
            accountIds: ['account-id-1'],
            newStatus: 'OFFERED',
            expiryTime: mockMoment.clone().add(24, 'hours'), // as always, watch mutability
            logType: 'ML_BOOST_OFFERED'
        };

        fetchMlBoostsStub.resolves([mockMlBoostFromRds(mlParameters)]);
        extractAccountIdsStub.resolves(mockAccountIds);
        
        accountStatusStub.resolves([{ boostId: testBoostId, accountUserMap: mockAccountUserMap }]);
        findUserIdsStub.resolves({ 'account-id-1': 'user-id-1' });

        tinyPostStub.resolves({
            body: JSON.stringify([{ 'user_id': 'user-id-1', 'should_offer': true }])
        });

        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200 })});

        momentStub.returns(mockMoment.clone());
        updateStatusStub.resolves([{ boostId: testBoostId, updatedTime: testUpdatedTime }]);
        
        const resultOfBoost = await handler.processMlBoosts({});

        expect(resultOfBoost).to.exist;
        expect(resultOfBoost).to.deep.equal({ result: 'SUCCESS', boostsProcessed: 1, offersMade: 1 });
        
        expect(fetchMlBoostsStub).to.have.been.calledOnceWithExactly();
        expect(accountStatusStub).to.have.been.calledOnceWithExactly({ boostIds: [testBoostId], accountIds: mockAccountIds });
        
        expect(tinyPostStub).to.have.been.calledOnceWithExactly(tinyOptions);
        
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(audienceInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(msgInvocation);
        
        expect(extractAccountIdsStub).to.have.been.calledOnceWithExactly(testAudienceId);
        
        expect(updateStatusStub).to.have.been.calledOnceWithExactly([expectedStatusUpdateInstruction]);
        
        expect(findBoostLogStub).to.have.not.been.called;
    });

    it('Handles recurring machine determined boost offerings', async () => {
        const mlParameters = { onlyOfferOnce: false, minIntervalBetweenRuns: { unit: 'days', value: 30 }};
        const mockAccountIds = ['account-id-1', 'account-id-2', 'account-id-3', 'account-id-4'];

        const tinyOptions = {
            url: config.get('mlSelection.endpoint'),
            data: {
                'boost_parameters': { 'boost_amount_whole_currency': 10, 'boost_type_category': 'GAME::CHASE_ARROW' },
                'candidate_users': ['user-id-1', 'user-id-2', 'user-id-3']
            }
        };

        const mockMoment = moment();

        const audiencePayload = { operation: 'refresh', params: { audienceId: testAudienceId }};
        const audienceInvocation = helper.wrapLambdaInvoc('audience_selection', false, audiencePayload);

        const createMsgInstruction = (userId) => ({ 
            destinationUserId: userId, 
            instructionId: testInstructionId, 
            parameters: mockMlBoostFromRds(mlParameters) 
        });

        const msgInstructions = [createMsgInstruction('user-id-1'), createMsgInstruction('user-id-3')];
        const msgInvocation = helper.wrapLambdaInvoc('message_user_create_once', true, { instructions: msgInstructions });

        const mockBoostLog = (accountId) => ({
            logId: testLogId,
            creationTime: testCreationTime,
            boostId: testBoostId,
            accountId,
            logType: 'ML_BOOST_OFFERED'
        });

        fetchMlBoostsStub.resolves([mockMlBoostFromRds(mlParameters)]);
        extractAccountIdsStub.resolves(mockAccountIds);

        momentStub.returns(mockMoment.clone());
        momentStub.withArgs(testCreationTime).returns(moment(testCreationTime));

        findBoostLogStub.onFirstCall().resolves(mockBoostLog('account-id-1'));
        findBoostLogStub.onSecondCall().resolves(mockBoostLog('account-id-2'));
        findBoostLogStub.onThirdCall().resolves({}); // i.e., not called before

        const tooSoonLog = { ...mockBoostLog('account-id-4'), creationTime: moment().subtract(3, 'days') };
        findBoostLogStub.onCall(3).resolves(tooSoonLog);

        findUserIdsStub.resolves({ 'account-id-1': 'user-id-1', 'account-id-2': 'user-id-2', 'account-id-3': 'user-id-3' });
        
        const offerDecision = (userId, shouldOffer) => ({ 'user_id': userId, 'should_offer': shouldOffer });
        tinyPostStub.resolves({
            body: JSON.stringify([offerDecision('user-id-1', true), offerDecision('user-id-2', false), offerDecision('user-id-3', true)])
        });

        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200 }) });

        updateStatusStub.resolves([{ boostId: testBoostId, updatedTime: testUpdatedTime }]);

        const resultOfBoost = await handler.processMlBoosts({});

        expect(resultOfBoost).to.exist;
        expect(resultOfBoost).to.deep.equal({ result: 'SUCCESS', boostsProcessed: 1, offersMade: 2 });


        expect(fetchMlBoostsStub).to.have.been.calledOnceWithExactly();
        expect(extractAccountIdsStub).to.have.been.calledOnceWithExactly(testAudienceId);
        
        expect(accountStatusStub).to.have.not.been.called;
        expect(findBoostLogStub.callCount).to.equal(4);
        mockAccountIds.map((accountId) => expect(findBoostLogStub).to.have.been.calledWithExactly(testBoostId, accountId, 'ML_BOOST_OFFERED'));
        
        expect(findUserIdsStub).to.have.been.calledWithExactly(['account-id-1', 'account-id-2', 'account-id-3'], true);
        expect(tinyPostStub).to.have.been.calledOnceWithExactly(tinyOptions);
        
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(audienceInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(msgInvocation);
        
        const expectedStatusUpdateInstruction = {
            boostId: testBoostId,
            accountIds: ['account-id-1', 'account-id-3'],
            newStatus: 'OFFERED',
            expiryTime: mockMoment.clone().add(24, 'hours'),
            logType: 'ML_BOOST_OFFERED'
        };

        // helper.logNestedMatches(expectedStatusUpdateInstruction, updateStatusStub.getCall(0).args[0][0]);
        expect(updateStatusStub).to.have.been.calledOnceWithExactly([expectedStatusUpdateInstruction]);
    });

    it('Restricts to certain number at max', async () => {
        const mlParameters = { onlyOfferOnce: false, maxUsersPerOfferRun: { basis: 'ABSOLUTE', value: 10 }};
        fetchMlBoostsStub.resolves([mockMlBoostFromRds(mlParameters)]);

        const mockAccountIds = Array(15).fill().map((_, index) => `account-id-${index}`);
        extractAccountIdsStub.resolves(mockAccountIds);
        
        const userIdMap = mockAccountIds.reduce((obj, accountId, index) => ({ ...obj, [accountId]: `user-id-${index}` }), {});
        findUserIdsStub.resolves(userIdMap);
        
        const offerDecisions = Object.values(userIdMap).map((userId) => ({ 'user_id': userId, 'should_offer': true }));
        tinyPostStub.resolves({ body: JSON.stringify(offerDecisions) });

        const mockMoment = moment();
        momentStub.returns(mockMoment.clone());
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200 }) });
        updateStatusStub.resolves([{ boostId: testBoostId, updatedTime: testUpdatedTime }]);

        const resultOfBoost = await handler.processMlBoosts({});
        expect(resultOfBoost).to.deep.equal({ result: 'SUCCESS', boostsProcessed: 1, offersMade: 10 });
        
        expect(accountStatusStub).to.have.not.been.called;
        
        // here is the point -- only ten of these
        const expectedStatusUpdateInstruction = {
            boostId: testBoostId,
            accountIds: mockAccountIds.slice(0, 10),
            newStatus: 'OFFERED',
            expiryTime: mockMoment.clone().add(24, 'hours'),
            logType: 'ML_BOOST_OFFERED'
        };

        // helper.logNestedMatches(expectedStatusUpdateInstruction, updateStatusStub.getCall(0).args[0][0]);
        expect(updateStatusStub).to.have.been.calledOnceWithExactly([expectedStatusUpdateInstruction]);
        expect(publishEventStub).to.have.been.calledOnceWith(Object.values(userIdMap).slice(0, 10), 'BOOST_OFFERED_GAME');
    });
});
