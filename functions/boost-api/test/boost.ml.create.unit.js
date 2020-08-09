'use strict';

// const logger = require('debug')('jupiter:boosts:test');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const insertBoostStub = sinon.stub();
const findBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const alterBoostStub = sinon.stub();
const findMsgInstructStub = sinon.stub();
const findUserIdsStub = sinon.stub();

const momentStub = sinon.stub();

const publishStub = sinon.stub();
const publishMultiStub = sinon.stub();

const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-create-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'setBoostMessages': alterBoostStub,
        'findMsgInstructionByFlag': findMsgInstructStub,
        'findUserIdsForAccounts': findUserIdsStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub, findBoostStub, findAccountsStub, updateBoostAccountStub, alterBoostStub, lamdbaInvokeStub, publishMultiStub);

const testStartTime = moment();
const testEndTime = moment();
const testAudienceId = uuid();

describe('*** UNIT TEST BOOST CREATION *** Persists ML params', () => {    
    const testInstructionId = uuid();
    const testCreatingUserId = uuid();

    const messageTemplates = {
        UNLOCKED: {
            title: 'Boost challenge unlocked!',
            body: 'Your top up was successful and you stand a chance to win R20. Follow the instructions below to play the game',
            display: {
                'type': 'MODAL',
                'iconType': 'SMILEY_FACE'
            },
            actionToTake: 'PLAY_GAME'
        }
    };

    const testStatusConditions = {
        OFFERED: ['message_instruction_created'],
        UNLOCKED: ['save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'],
        REDEEMED: ['number_taps_greater_than #{20::20000}'],
        FAILED: ['number_taps_less_than #{20::20000}']
    };

    const gameParams = {
        gameType: 'CHASE_ARROW',
        timeLimitSeconds: 20,
        winningThreshold: 20,
        instructionBand: 'Tap the screen as many times as you can in 20 seconds',
        entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}',
        allowRepeatPlay: false,
    };

    const mockBoostToFromPersistence = {
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
        statusConditions: testStatusConditions,
        defaultStatus: 'CREATED',
        gameParams,
        mlParameters: {
            maxPortionOfAudience: 0.2,
            minIntervalBetweenRuns: { unit: 'days', value: 30 }
        },
        expiryParameters: {
            individualizedExpiry: true,
            timeUntilExpiry: { unit: 'hours', value: 24 }
        },
        messageInstructionIds: { }
    };

    beforeEach(() => resetStubs());

    // ML boost creation is similar to any other boost creation, the key differences being the inclusion of 
    // mlBoostParameters in the event body and the presentationType 'MACHINE_DETERMINED' in messagesToCreate
    it('Happy path boost with ml params', async () => {
        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ message: { instructionId: testInstructionId } })
        })})});

        const expectedFromRds = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 2,
            accountIds: ['account-id-1', 'account-id-2']
        };

        insertBoostStub.resolves(expectedFromRds);
    
        const testBodyOfEvent = {
            label: 'Midweek Catch Arrow',
            creatingUserId: testCreatingUserId,
            boostTypeCategory: 'GAME::CHASE_ARROW',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: '10000000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            gameParams,
            messagesToCreate: [{
                boostStatus: 'ALL',
                presentationType: 'MACHINE_DETERMINED',
                template: messageTemplates.UNLOCKED,
                allowRepeatPlay: false,
            }],
            mlParameters: {
                maxPortionOfAudience: 0.20,
                minIntervalBetweenRuns: { unit: 'days', value: 30 }
            },
            expiryParameters: {
                individualizedExpiry: true,
                timeUntilExpiry: { unit: 'hours', value: 24 }
            }    
        };

        findUserIdsStub.resolves(['user-id-1', 'user-id-2']);

        const resultOfInstruction = await handler.createBoost(testBodyOfEvent);
        expect(resultOfInstruction).to.deep.equal(expectedFromRds);

        const expectedInstructionPayload = {
            actionToTake: 'PLAY_GAME',
            audienceId: testAudienceId,
            audienceType: 'GENERAL',
            boostStatus: 'ALL',
            creatingUserId: testCreatingUserId,
            endTime: testEndTime.format(),
            messagePriority: 100,
            presentationType: 'MACHINE_DETERMINED',
            templates: {
                template: {
                    DEFAULT: { actionContext: { boostId: expectedFromRds.boostId }, ...messageTemplates.UNLOCKED }
                }
            }
        };
        const msgInstructionInvocation = testHelper.wrapLambdaInvoc('message_instruct_create', false, expectedInstructionPayload);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(msgInstructionInvocation);

        const expectedBoost = { ...mockBoostToFromPersistence };
        expectedBoost.audienceId = testAudienceId;
        expect(insertBoostStub).to.have.been.calledWithExactly(expectedBoost);

        expect(findUserIdsStub).to.have.been.calledWithExactly(['account-id-1', 'account-id-2']);
        const expectedBoostAmount = { boostAmount: 100000, boostUnit: 'HUNDREDTH_CENT', boostCurrency: 'USD' };
        const expectedUserLogOptions = {
            initiator: testCreatingUserId,
            context: {
                boostType: 'GAME', boostCategory: 'CHASE_ARROW', boostId: expectedFromRds.boostId, ...expectedBoostAmount,
                boostStartTime: testStartTime.valueOf(), boostEndTime: testEndTime.valueOf(), gameParams,
                rewardParameters: undefined, statusConditions: mockBoostToFromPersistence.statusConditions
            }
        };
        
        expect(publishMultiStub).to.have.been.calledOnceWithExactly(['user-id-1', 'user-id-2'], 'BOOST_CREATED_GAME', expectedUserLogOptions);
    });

});
