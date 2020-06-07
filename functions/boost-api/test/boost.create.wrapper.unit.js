'use strict';

// const logger = require('debug')('jupiter:boosts:test');
const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;

chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const createBoostStub = sinon.stub();
const fetchRelationshipsStub = sinon.stub();
const fetchBoostStub = sinon.stub();

const fetchDynamoRowStub = sinon.stub();

const publishSingleEventStub = sinon.stub();
const publishMultiEventStub = sinon.stub();

const momentStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-create-wrapper', {
    './persistence/rds.boost': {
        'fetchUserIdsForRelationships': fetchRelationshipsStub,
        'fetchBoost': fetchBoostStub,
        '@noCallThru': true
    },
    './boost-create-handler': {
        'createBoost': createBoostStub,
        '@noCallThru': true
    },
    'dynamo-common': {
        'fetchSingleRow': fetchDynamoRowStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishSingleEventStub,
        'publishMultiUserEvent': publishMultiEventStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const resetStubs = () => helper.resetStubs(createBoostStub, fetchRelationshipsStub, fetchDynamoRowStub, fetchBoostStub, publishSingleEventStub, publishMultiEventStub);

describe('*** UNIT TEST BOOSTS *** Validation and error checks for insert', () => {
    
    beforeEach(resetStubs);

    it('Rejects event without authorization', async () => {
        const resultOfCall = await handler.createBoostWrapper({ boostType: 'FRAUD' });
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });

        expect(createBoostStub).to.not.have.been.called;
    });

    it('Rejects all categories except referrals if user is ordinary role', async () => {
        const resultOfCall = await handler.createBoostWrapper(helper.wrapEvent({ boostTypeCategory: 'SIMPLE::TIME_LIMITED' }, uuid(), 'ORDINARY_USER'));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });
        expect(createBoostStub).to.not.have.been.called;
    });

    it('Swallows an error and return its message', async () => {
        const resultOfCall = await handler.createBoostWrapper(helper.wrapEvent('This is badly formed', uuid(), 'SYSTEM_ADMIN'));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('statusCode', 500);
        expect(createBoostStub).to.not.have.been.called;
    });

});

describe('*** UNIT TEST BOOSTS *** General audience, via wrapper (simple admin call)', () => {

    beforeEach(() => resetStubs());

    const testRedemptionMsgId = uuid();
    
    it('Happy path creating a time-limited simple, general boost', async () => {
        const testAdminId = uuid();
        const testStartTime = moment();
        const testEndTime = moment().add(7, 'days');
        const testAudienceId = uuid();

        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testNumberOfUsersInAudience = 100000;

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testNumberOfUsersInAudience
        };
        createBoostStub.resolves(persistenceResult);

        const testBodyOfEvent = {
            label: 'Monday Limited Time Boost',
            boostTypeCategory: 'SIMPLE::TIME_LIMITED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: 10000000,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}'] },
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId }]
        };

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testAdminId, 'SYSTEM_ADMIN'));

        const bodyOfResult = helper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(persistenceResult);

        expect(createBoostStub).to.have.been.calledWithExactly({ ...testBodyOfEvent, creatingUserId: testAdminId });
    });

});


describe('*** UNIT TEST BOOSTS *** Friends audience', () => {

    beforeEach(() => resetStubs());

    const testStartTime = moment();
    const testEndTime = moment().add(1, 'hour');

    const testCreatingUserId = uuid();
    const testInitiatedUserId = uuid();
    const testAcceptedUserId = uuid();

    const testBoostId = uuid();
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
    
    it('Happy path creating a friend-based pooled boost', async () => {
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testRelationshipIds.length + 1
        };

        const testGameParams = {
            gameType: 'TAP_SCREEN',
            timeLimitSeconds: 20,
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
        };

        const testFloatParams = {
            maxPoolEntry: { amount: 500000, unit: 'HUNDREDTH_CENT', currency: 'USD' }, 
            maxPoolPercent: 0.1, 
            clientFloatContribution: { type: 'PERCENT_OF_POOL', value: 0.01, requiredFriends: 3 }
        };
    
        const testBodyOfEvent = {
            label: 'Friend Initiated Boost',
            endTimeMillis: testEndTime.valueOf(),
            friendships: testRelationshipIds,
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 500000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.05
            },
            gameParams: testGameParams
        };

        const expectedBudget = 500000 * (testFriendships.length + 1) * (0.05 + 0.01); // percent of pool + amount from bonus
        
        const expectedBoostToHandler = {
            creatingUserId: testCreatingUserId,
            label: 'Friend Initiated Boost',
            initialStatus: 'OFFERED',
            boostTypeCategory: 'GAME::TAP_SCREEN',
            boostAmountOffered: '0::HUNDREDTH_CENT::USD',
            boostBudget: expectedBudget,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { 
                UNLOCKED: ['save_event_greater_than #{500000::HUNDREDTH_CENT::USD}', 'save_tagged_with #{THIS_BOOST}'],
                PENDING: ['number_taps_greater_than #{0::20000}'],
                REDEEMED: ['number_taps_in_first_N #{1::20000}'] 
            },
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 500000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.05,
                clientFloatContribution: testFloatParams.clientFloatContribution
            },
            boostAudienceType: 'SOCIAL',
            boostAudienceSelection: {
                conditions: [{ op: 'in', prop: 'systemWideUserId', value: [testCreatingUserId, ...testFriendshipUserIds] }]
            },
            gameParams: { ...testGameParams, numberWinners: 1 },
            tags: ['FRIEND_TOURNAMENT']
        };

        fetchRelationshipsStub.resolves(testFriendships);

        fetchDynamoRowStub.onFirstCall().resolves({ clientId: testClientId, floatId: testFloatId, personalName: 'Someone' });
        fetchDynamoRowStub.onSecondCall().resolves({
            bonusPoolSystemWideId: 'primary_bonus_pool',
            friendTournamentParameters: testFloatParams,
            currency: 'USD'
        });

        createBoostStub.resolves(persistenceResult);
        fetchBoostStub.resolves({ boostId: testBoostId, ...expectedBoostToHandler });

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testCreatingUserId, 'ORDINARY_USER'));

        const bodyOfResult = helper.standardOkayChecks(resultOfInstruction);
        
        const { result, createdBoost } = bodyOfResult;
        expect(result).to.equal('SUCCESS');
        expect(createdBoost).to.deep.equal({ boostId: testBoostId, ...expectedBoostToHandler });

        expect(createBoostStub).to.have.been.calledOnceWithExactly(expectedBoostToHandler);
        expect(fetchRelationshipsStub).to.have.been.calledOnceWithExactly(testRelationshipIds);

        expect(fetchDynamoRowStub).to.have.been.calledTwice;
        expect(fetchDynamoRowStub).to.have.been.calledWithExactly('UserProfileTable', { systemWideUserId: testCreatingUserId });
        expect(fetchDynamoRowStub).to.have.been.calledWithExactly('ClientFloatTable', { clientId: 'some_client_co', floatId: 'primary_cash' });

        const expectedMessageParameters = {
            friendName: 'Someone',
            tournamentName: 'Friend Initiated Boost',
            entryAmount: '$50', // this is a message-specific parameter, so message pusher will not apply logic, it will just inject
            friendsForBonus: 3,
            bonusAmountMax: '$15'
        };

        const expectedContext = { boostId: testBoostId, messageParameters: expectedMessageParameters };
        const expectedMultiOptions = { initiator: testCreatingUserId, context: expectedContext };
        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(testFriendshipUserIds, 'INVITED_TO_FRIEND_TOURNAMENT', expectedMultiOptions);
        
        expect(publishSingleEventStub).to.have.been.calledOnceWithExactly(testCreatingUserId, 'CREATED_FRIEND_TOURNAMENT', { context: expectedContext });
    });

    it('Handles disabled boost contribution', async () => {
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testRelationshipIds.length + 1
        };

        const testGameParams = {
            gameType: 'TAP_SCREEN',
            timeLimitSeconds: 20,
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
        };

        const testFloatParams = {
            maxPoolEntry: { amount: 50 * 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' }, 
            maxPoolPercent: 0.1, 
            clientFloatContribution: { type: 'NONE' }
        };
    
        const testBodyOfEvent = {
            label: 'Friend Initiated Boost',
            endTimeMillis: testEndTime.valueOf(),
            friendships: testRelationshipIds,
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 500000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.05
            },
            gameParams: testGameParams
        };

        const expectedBudget = 500000 * (testFriendships.length + 1) * (0.05); // percent of pool but no amount from bonus
        
        const expectedBoostToHandler = {
            creatingUserId: testCreatingUserId,
            label: 'Friend Initiated Boost',
            initialStatus: 'OFFERED',
            boostTypeCategory: 'GAME::TAP_SCREEN',
            boostAmountOffered: '0::HUNDREDTH_CENT::USD',
            boostBudget: expectedBudget,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { 
                UNLOCKED: ['save_event_greater_than #{500000::HUNDREDTH_CENT::USD}', 'save_tagged_with #{THIS_BOOST}'],
                PENDING: ['number_taps_greater_than #{0::20000}'],
                REDEEMED: ['number_taps_in_first_N #{1::20000}'] 
            },
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 500000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.05,
                clientFloatContribution: testFloatParams.clientFloatContribution
            },
            boostAudienceType: 'SOCIAL',
            boostAudienceSelection: {
                conditions: [{ op: 'in', prop: 'systemWideUserId', value: [testCreatingUserId, ...testFriendshipUserIds] }]
            },
            gameParams: { ...testGameParams, numberWinners: 1 },
            tags: ['FRIEND_TOURNAMENT']
        };

        fetchRelationshipsStub.resolves(testFriendships);

        fetchDynamoRowStub.onFirstCall().resolves({ clientId: testClientId, floatId: testFloatId, personalName: 'Someone' });
        fetchDynamoRowStub.onSecondCall().resolves({
            bonusPoolSystemWideId: 'primary_bonus_pool',
            friendTournamentParameters: testFloatParams,
            currency: 'USD'
        });

        createBoostStub.resolves(persistenceResult);
        fetchBoostStub.resolves({ boostId: testBoostId, ...expectedBoostToHandler });

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testCreatingUserId, 'ORDINARY_USER'));

        const bodyOfResult = helper.standardOkayChecks(resultOfInstruction);
        
        const { result, createdBoost } = bodyOfResult;
        expect(result).to.equal('SUCCESS');
        expect(createdBoost).to.deep.equal({ boostId: testBoostId, ...expectedBoostToHandler });

        // most expectations are covered above
        expect(createBoostStub).to.have.been.calledOnceWithExactly(expectedBoostToHandler);

        const expectedMessageParameters = {
            friendName: 'Someone',
            tournamentName: 'Friend Initiated Boost',
            entryAmount: '$50', // this is a message-specific parameter, so message pusher will not apply logic, it will just inject
            bonusAmountMax: '$12.50'
        };

        const expectedContext = { boostId: testBoostId, messageParameters: expectedMessageParameters };
        const expectedMultiOptions = { initiator: testCreatingUserId, context: expectedContext };
        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(testFriendshipUserIds, 'INVITED_TO_FRIEND_TOURNAMENT', expectedMultiOptions);        
    });

    it('Applies max correctly', async () => {
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testRelationshipIds.length + 1
        };

        const testGameParams = {
            gameType: 'TAP_SCREEN',
            timeLimitSeconds: 20,
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
        };

        const testFloatParams = {
            maxPoolEntry: { amount: 50 * 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' }, 
            maxPoolPercent: 0.1, 
            clientFloatContribution: { type: 'PERCENT_OF_POOL', value: 0.01, requiredFriends: 3 }
        };
    
        const testBodyOfEvent = {
            label: 'Friend Initiated Boost',
            endTimeMillis: testEndTime.valueOf(),
            friendships: testRelationshipIds,
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 500 * 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.5
            },
            gameParams: testGameParams
        };

        const expectedBudget = 500000 * (testFriendships.length + 1) * (0.1 + 0.01); // percent of pool + amount from bonus
        
        const expectedBoostToHandler = {
            creatingUserId: testCreatingUserId,
            label: 'Friend Initiated Boost',
            initialStatus: 'OFFERED',
            boostTypeCategory: 'GAME::TAP_SCREEN',
            boostAmountOffered: '0::HUNDREDTH_CENT::USD',
            boostBudget: expectedBudget,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { 
                UNLOCKED: ['save_event_greater_than #{500000::HUNDREDTH_CENT::USD}', 'save_tagged_with #{THIS_BOOST}'],
                PENDING: ['number_taps_greater_than #{0::20000}'],
                REDEEMED: ['number_taps_in_first_N #{1::20000}'] 
            },
            rewardParameters: {
                rewardType: 'POOLED',
                poolContributionPerUser: { amount: 500000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                percentPoolAsReward: 0.1,
                clientFloatContribution: testFloatParams.clientFloatContribution
            },
            boostAudienceType: 'SOCIAL',
            boostAudienceSelection: {
                conditions: [{ op: 'in', prop: 'systemWideUserId', value: [testCreatingUserId, ...testFriendshipUserIds] }]
            },
            gameParams: { ...testGameParams, numberWinners: 1 },
            tags: ['FRIEND_TOURNAMENT']
        };

        fetchRelationshipsStub.resolves(testFriendships);

        fetchDynamoRowStub.onFirstCall().resolves({ clientId: testClientId, floatId: testFloatId, personalName: 'Someone' });
        fetchDynamoRowStub.onSecondCall().resolves({
            bonusPoolSystemWideId: 'primary_bonus_pool',
            friendTournamentParameters: testFloatParams,
            currency: 'USD'
        });

        createBoostStub.resolves(persistenceResult);
        fetchBoostStub.resolves({ boostId: testBoostId, ...expectedBoostToHandler });

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testCreatingUserId, 'ORDINARY_USER'));

        const bodyOfResult = helper.standardOkayChecks(resultOfInstruction);
        
        const { result, createdBoost } = bodyOfResult;
        expect(result).to.equal('SUCCESS');
        expect(createdBoost).to.deep.equal({ boostId: testBoostId, ...expectedBoostToHandler });

        // most expectations are covered above
        expect(createBoostStub).to.have.been.calledOnceWithExactly(expectedBoostToHandler);

        const expectedMessageParameters = {
            friendName: 'Someone',
            tournamentName: 'Friend Initiated Boost',
            entryAmount: '$50', // this is a message-specific parameter, so message pusher will not apply logic, it will just inject
            friendsForBonus: 3,
            bonusAmountMax: '$27.50'
        };

        const expectedContext = { boostId: testBoostId, messageParameters: expectedMessageParameters };
        const expectedMultiOptions = { initiator: testCreatingUserId, context: expectedContext };
        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(testFriendshipUserIds, 'INVITED_TO_FRIEND_TOURNAMENT', expectedMultiOptions);        
    });

    it('Rejects non-pooled reward creation', async () => {
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

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
            }
        };

        const resultOfInstruction = await handler.createBoostWrapper(helper.wrapEvent(testBodyOfEvent, testCreatingUserId, 'ORDINARY_USER'));

        expect(resultOfInstruction).to.deep.equal({ statusCode: 403 });
        expect(createBoostStub).to.have.not.been.called;
        expect(fetchRelationshipsStub).to.have.not.been.called;
    });

});
