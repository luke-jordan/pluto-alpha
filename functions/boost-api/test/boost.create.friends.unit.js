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

const insertBoostStub = sinon.stub();
const fetchRelationshipsStub = sinon.stub();
const momentStub = sinon.stub();

const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-create-handler', {
    './persistence/rds.boost': {
        'fetchUserIdsForRelationships': fetchRelationshipsStub,
        'insertBoost': insertBoostStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'moment': momentStub,
    '@noCallThru': true
});

const resetStubs = () => helper.resetStubs(insertBoostStub, lamdbaInvokeStub, fetchRelationshipsStub);

describe('*** UNIT TEST BOOSTS *** Friends audience', () => {

    beforeEach(() => resetStubs());

    const testStartTime = moment();
    const testEndTime = moment().add(7, 'days');

    const testCreatingUserId = uuid();
    const testInitiatedUserId = uuid();
    const testAcceptedUserId = uuid();
    const testRedemptionMsgId = uuid();
    const testCreatedAudienceId = uuid();

    const testClientId = 'some_client_co';
    const testFloatId = 'primary_cash';

    const testRelationshipIds = helper.createUUIDArray(4);
    const testFriendshipUserIds = [testAcceptedUserId, testInitiatedUserId, testAcceptedUserId, testInitiatedUserId];
    const testFriendships = [
        { initiatedUserId: testCreatingUserId, acceptedUserId: testAcceptedUserId },
        { initiatedUserId: testInitiatedUserId, acceptedUserId: testCreatingUserId },
        { initiatedUserId: testCreatingUserId, acceptedUserId: testAcceptedUserId },
        { initiatedUserId: testInitiatedUserId, acceptedUserId: testCreatingUserId }
    ];

    const gameParams = {
        gameType: 'TAP_SCREEN',
        timeLimitSeconds: 20,
        winningThreshold: 20,
        instructionBand: 'Tap the screen as many times as you can in 20 seconds',
        entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
    };
    
    const mockBoostToFromPersistence = {
        creatingUserId: testCreatingUserId,
        label: 'Friend Initiated Boost',
        boostType: 'GAME',
        boostCategory: 'TAP_SCREEN',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: { REDEEMED: ['number_taps_greater_than #{20::20000}'] },
        rewardParameters: {
            rewardType: 'POOLED',
            poolContributionPerUser: { amount: 50000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            additionalBonusToPool: { amount: 5000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            percentPoolAsReward: 0.05
        },
        boostAudienceType: 'FRIENDSHIPS',
        audienceId: testCreatedAudienceId,
        defaultStatus: 'PENDING',
        messageInstructionIds: {},
        gameParams
    };

    it('Happy path creating a friend-based pooled boost', async () => {
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testNumberOfUsersInAudience = 10;

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testNumberOfUsersInAudience
        };
        insertBoostStub.resolves(persistenceResult);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ audienceId: testCreatedAudienceId })
        })})});

        fetchRelationshipsStub.resolves(testFriendships);

        const testBodyOfEvent = {
            label: 'Friend Initiated Boost',
            boostTypeCategory: 'GAME::TAP_SCREEN',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: 10000000,
            boostSource: { bonusPoolId: 'primary_bonus_pool', clientId: testClientId, floatId: testFloatId },
            redemptionMsgInstructions: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId }],
            endTimeMillis: testEndTime.valueOf(),
            initialStatus: 'PENDING',
            boostAudienceType: 'FRIENDSHIPS',
            friendships: testRelationshipIds,
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 50000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                additionalBonusToPool: { amount: 5000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.05
            },
            gameParams
        };

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testCreatingUserId, 'ORDINARY_USER'));

        const expectedAudiencePayload = {
            operation: 'create',
            params: {
                clientId: testClientId,
                creatingUserId: testCreatingUserId,
                isDynamic: false,
                conditions: [{ op: 'in', prop: 'systemWideUserId', value: [testCreatingUserId, ...testFriendshipUserIds] }]
            }
        };
        const expectedInvocation = helper.wrapLambdaInvoc(config.get('lambdas.audienceHandle'), false, expectedAudiencePayload);

        const bodyOfResult = helper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(persistenceResult);

        expect(insertBoostStub).to.have.been.calledWithExactly(mockBoostToFromPersistence);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedInvocation);
        expect(fetchRelationshipsStub).to.have.been.calledOnceWithExactly(testRelationshipIds);
    });

    it('Rejects non-pooled reward creation', async () => {
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testNumberOfUsersInAudience = 10;

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testNumberOfUsersInAudience
        };
        insertBoostStub.resolves(persistenceResult);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ audienceId: testCreatedAudienceId })
        })})});

        fetchRelationshipsStub.resolves(testFriendshipUserIds);

        const testBodyOfEvent = {
            label: 'Friend Initiated Boost',
            boostTypeCategory: 'GAME::TAP_SCREEN',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: 10000000,
            boostSource: { bonusPoolId: 'primary_bonus_pool', clientId: testClientId, floatId: testFloatId },
            endTimeMillis: testEndTime.valueOf(),
            gameParams: { gameType: 'FRIEND_BOOST' },
            initialStatus: 'PENDING',
            boostAudienceType: 'FRIENDSHIPS',
            friendships: testRelationshipIds,
            rewardParameters: {
                rewardType: 'RANDOM',
                distribution: 'UNIFORM',
                realizedRewardModuloZeroTarget: 5000
            },
            redemptionMsgInstructions: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId }]
        };

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testCreatingUserId, 'ORDINARY_USER'));

        expect(resultOfInstruction).to.deep.equal({ statusCode: 403 });
        expect(insertBoostStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(fetchRelationshipsStub).to.have.not.been.called;
    });

});
