'use strict';

const moment = require('moment');
const helper = require('./boost.test.helper');

const { ACTIVE_BOOST_STATUS } = require('../boost.util');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const fetchActiveDynamicBoostStub = sinon.stub();
const fetchActiveStandardBoostStub = sinon.stub();

const findNewAudienceMembersStub = sinon.stub();
const insertBoostAccountsStub = sinon.stub();

const fetchAccountsStub = sinon.stub();
const fetchUserIdsStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();
const updateBoostStatusStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

// const publishSingleEventStub = sinon.stub();
const publishMultiEventStub = sinon.stub();

const handler = proxyquire('../boost-scheduled-handler', {
    './persistence/rds.boost': {
        'fetchBoostsWithDynamicAudiences': fetchActiveDynamicBoostStub,
        'fetchActiveStandardBoosts': fetchActiveStandardBoostStub,
        'fetchNewAudienceMembers': findNewAudienceMembersStub,
        'insertBoostAccountJoins': insertBoostAccountsStub,
        'findAccountsForBoost': fetchAccountsStub,
        'findUserIdsForAccounts': fetchUserIdsStub,
        'updateBoostAccountStatus': updateBoostStatusStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        '@noCallThru': true
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiEventStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': class {
            // eslint-disable-next-line brace-style
            constructor () { this.invoke = lambdaInvokeStub; }
        }
    }
});

const resetStubs = () => helper.resetStubs(
    fetchActiveDynamicBoostStub, fetchActiveStandardBoostStub, findNewAudienceMembersStub, 
    insertBoostAccountsStub, updateBoostStatusStub, redemptionHandlerStub,
    fetchAccountsStub, fetchUserIdsStub, lambdaInvokeStub
);

describe('*** UNIT TEST REFRESHING DYNAMIC BOOSTS ***', async () => {

    beforeEach(resetStubs);

    const refreshInvocation = (audienceId) => ({
        FunctionName: 'audience_selection',
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ operation: 'refresh', params: { audienceId } })
    });

    it('Do nothing if no active boosts with dynamic audiences', async () => {
        fetchActiveDynamicBoostStub.resolves([]);
        const resultOfProcess = await handler.refreshDynamicAudienceBoosts();
        expect(resultOfProcess).to.deep.equal({ result: 'NO_BOOSTS' });
        
        expect(fetchActiveDynamicBoostStub).to.have.been.calledOnceWithExactly();
        
        helper.expectNoCalls(findNewAudienceMembersStub, insertBoostAccountsStub, lambdaInvokeStub, fetchUserIdsStub);
    });

    it('Process a boost with dynamic audience, no new audience members', async () => {
        fetchActiveDynamicBoostStub.resolves([{
            boostId: 'boost-id',
            audienceId: 'audience-id'
        }]);

        findNewAudienceMembersStub.resolves([]);
        
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200 })}); // we just need to know it's completed

        const resultOfProcess = await handler.refreshDynamicAudienceBoosts();
        expect(resultOfProcess).to.deep.equal({ result: 'BOOSTS_REFRESHED', boostsRefreshed: 1, newOffers: 0 });

        expect(fetchActiveDynamicBoostStub).to.have.been.calledOnceWithExactly();
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(refreshInvocation('audience-id'));
        expect(findNewAudienceMembersStub).to.have.been.calledOnceWithExactly('boost-id', 'audience-id');

        helper.expectNoCalls(insertBoostAccountsStub, fetchUserIdsStub);
    });

    it('Process dynamic boost, new audience members', async () => {
        const mockBoost = {
            boostId: 'boost-id',
            creatingUserId: 'creator-id',
            
            boostType: 'SOCIAL',
            boostCategory: 'ADD_FRIEND',

            boostStartTime: moment(),
            boostEndTime: moment().add(6, 'months'),

            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',

            audienceId: 'audience-id',
            defaultStatus: 'OFFERED',

            statusConditions: {
                REDEEMED: ['total_number_friends #{5::INITIATED}']
            },

            messageInstructions: [
                { msgInstructionId: 'instruction-1', status: 'OFFERED', accountId: 'ALL' },
                { msgInstructionId: 'instruction-2', status: 'OFFERED', accountId: 'ALL' }
            ]
        };

        fetchActiveDynamicBoostStub.resolves([mockBoost]);

        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200 })}); // message creation instruction is async

        findNewAudienceMembersStub.resolves(['account-1', 'account-2']);
        fetchUserIdsStub.resolves(['user-2']);

        const resultOfProcess = await handler.refreshDynamicAudienceBoosts();
        expect(resultOfProcess).to.deep.equal({ result: 'BOOSTS_REFRESHED', boostsRefreshed: 1, newOffers: 2 });

        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(refreshInvocation('audience-id'));

        expect(insertBoostAccountsStub).to.have.been.calledOnceWithExactly(['boost-id'], ['account-1', 'account-2'], 'OFFERED');

        expect(fetchUserIdsStub).to.have.been.calledOnceWithExactly(['account-1', 'account-2']);

        const expectedMessageParameters = { boostAmount: '$10' };

        const msgInstructionPayload = (instructionId, destinationUserId) => ({ 
            instructionId, 
            destinationUserId,
            parameters: expectedMessageParameters
        });

        const msgInstructions = [msgInstructionPayload('instruction-1', 'user-2'), msgInstructionPayload('instruction-2', 'user-2')];
        // going to use lambda events -- make sure idempotent
        const msgInvocation = helper.wrapLambdaInvoc('message_user_create_once', true, { instructions: msgInstructions });

        expect(lambdaInvokeStub).to.have.been.calledWithExactly(msgInvocation);

        const expectedUserLogOptions = {
            initiator: 'creator-id',
            context: {
                boostType: 'SOCIAL', 
                boostCategory: 'ADD_FRIEND', 
                boostId: 'boost-id',
                boostAmount: 100000,
                boostUnit: 'HUNDREDTH_CENT',
                boostCurrency: 'USD',
                boostStartTime: mockBoost.boostStartTime.valueOf(), 
                boostEndTime: mockBoost.boostEndTime.valueOf(), 
                statusConditions: mockBoost.statusConditions,
                gameParams: undefined,
                rewardParameters: undefined
            }
        };

        expect(publishMultiEventStub).to.have.been.calledOnce;
        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(['user-2'], 'BOOST_CREATED_SOCIAL', expectedUserLogOptions);
    });

});

describe('*** UNIT TEST CHECKING FOR TIME-BASED CONDITIONS ***', async () => {

    beforeEach(resetStubs);

    const testStatusConditions = { 
        UNLOCKED: ['event_does_not_follow #{SAVING_EVENT_SUCCESSFUL::ADMIN_SETTLED_WITHDRAWAL::90::DAYS}'],
        FAILED: ['event_does_follow #{SAVING_EVENT_SUCCESSFUL::ADMIN_SETTLED_WITHDRAWAL::90::DAYS}']
    };

    const nonTimeBasedCondition = {
        REDEEMED: ['save_event_greater_than #{100::WHOLE_CURRENCY::EUR}']
    };

    const mockBoost = (statusConditions, boostStartTime = moment().subtract(91, 'DAYS')) => ({
        boostId: 'boost-id',
        boostStartTime,
        statusConditions        
    });

    // these next two (args + response) are a bit of a lesson in prematurely optimizing for significant parallelization, to detriment of readability
    // (was born from designing to redeem a lot of boosts + accounts simultaneously, which now it's clear is very unlikely to happen)
    const expectedFindAccountArgs = { boostIds: ['boost-id'], status: ACTIVE_BOOST_STATUS };
    const mockAccountDict = {
        boostId: 'boost-id', 
        accountUserMap: {
            'account-1': { userId: 'user-1', status: 'OFFERED' }
        }
    };

    const setLambdaToReturn = (userEvents, userId = 'user-1') => {
        const payload = {
            result: 'SUCCESS',
            [userId]: {
                totalCount: userEvents.length,
                userEvents
            }
        };
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200, Payload: JSON.stringify(payload) })});
    };

    const expectedUpdateInstruction = (newStatus, accountId, logContext) => [{
        boostId: 'boost-id',
        accountIds: [accountId],
        newStatus,
        logType: 'STATUS_CHANGE',
        logContext: { newStatus, ...logContext }
    }];

    it('Scans active boost-account pairs for time based conditions expiring', async () => {

        // First we fetch all currently active non-friend boosts. Note: two alternatives for this:
        // (i) we could stick a flag on any boost with one of these conditions, and search by that, or
        // (ii) we could do a deep search through the status conditions looking for a sequence condition
        // but (i) would be fragile (somewhere the flag doesn't get added and ...), and (ii) would be hyper complex
        // since there are unlikely to be more than, ~20-30 non-friend-tournament boosts at any time, can handle this way

        fetchActiveStandardBoostStub.resolves([mockBoost(nonTimeBasedCondition)]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 0 });

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        helper.expectNoCalls(fetchAccountsStub, updateBoostStatusStub, redemptionHandlerStub);
    });

    it('Does not execute if boost is too new for interval to have elapsed', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions, moment().subtract(10, 'DAYS'))]);
        fetchAccountsStub.resolves([{ 'boost-id': {}}]); // not really relevant

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 0, accountsUpdated: 0 });

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(expectedFindAccountArgs);
        helper.expectNoCalls(updateBoostStatusStub, redemptionHandlerStub);

    });

    it('Executes conditions accordingly if any such found, but no account matches conditions', async () => {

        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves([mockAccountDict]);

        setLambdaToReturn([]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 0, accountsUpdated: 0 });

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(expectedFindAccountArgs);

        helper.expectNoCalls(updateBoostStatusStub, redemptionHandlerStub);
    });

    it('Does nothing if one event is present but not expired or none other', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves([mockAccountDict]);
        // fetchUserIdsStub.resolves(['user-1']);

        setLambdaToReturn([
            {
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(20, 'days').valueOf()
            }
        ]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 0, accountsUpdated: 0 });
        
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(expectedFindAccountArgs);

        helper.expectNoCalls(updateBoostStatusStub, redemptionHandlerStub); 
    });

    // note : this is all going to be quite expensive, so probably only run once a day/hour
    it('Executes conditions and flips status up', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves([mockAccountDict]);
        // fetchUserIdsStub.resolves(['user-1']);

        const mockEventHistory = [{
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(91, 'days').valueOf()
        }];

        setLambdaToReturn(mockEventHistory);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });
        
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(expectedFindAccountArgs);

        const expectedUpdate = expectedUpdateInstruction('UNLOCKED', 'account-1', { oldStatus: 'OFFERED', eventHistory: mockEventHistory });
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedUpdate);

        helper.expectNoCalls(redemptionHandlerStub);

    });

    it('Flips to failed if first event found, but second is also present', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves([mockAccountDict]);

        const mockEventHistory = [
            {
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(20, 'days').valueOf()
            },
            {
                userId: 'user-1',
                eventType: 'ADMIN_SETTLED_WITHDRAWAL',
                timestamp: moment().subtract(1, 'days').valueOf()
            }
        ];
        setLambdaToReturn(mockEventHistory);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });
        
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(expectedFindAccountArgs);

        const expectedUpdate = expectedUpdateInstruction('FAILED', 'account-1', { oldStatus: 'OFFERED', eventHistory: mockEventHistory });
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedUpdate);

        helper.expectNoCalls(redemptionHandlerStub); 
    });

    it('Redeems the boost if condition passes', async () => {
        const redemptionConditions = {
            REDEEMED: testStatusConditions.UNLOCKED
        };
        
        const mockBoostToRedeem = mockBoost(redemptionConditions);
        fetchActiveStandardBoostStub.resolves([mockBoostToRedeem]);
        fetchAccountsStub.resolves([mockAccountDict]);

        const mockEventHistory = [
            {
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(91, 'days').valueOf()
            }
        ];
        setLambdaToReturn(mockEventHistory);

        redemptionHandlerStub.resolves({
            'boost-id': {
                result: 'SUCCESS',
                boostAmount: 15000,
                amountFromBonus: 15000,
                floatTxIds: ['some-float-tx-id'],
                accountTxIds: ['some-account-tx-id']
            }
        });

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });        

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(expectedFindAccountArgs);

        const expectedLogContext = { 
            oldStatus: 'OFFERED', 
            newStatus: 'REDEEMED',
            boostAmount: 15000, 
            amountFromBonus: 15000,
            floatTxIds: ['some-float-tx-id'],
            accountTxIds: ['some-account-tx-id'],        
            eventHistory: mockEventHistory
        };
        const expectedUpdate = expectedUpdateInstruction('REDEEMED', 'account-1', expectedLogContext);
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedUpdate);
    
        const expectedEventForRedemption = {
            eventType: 'SEQUENCE_CHECK',
            eventContext: { 
                eventHistory: {
                    'account-1': mockEventHistory 
                }
            }
        };

        const expectedRedemptionCall = { 
            redemptionBoosts: [mockBoostToRedeem], 
            affectedAccountsDict: { 'boost-id': { 'account-1': { userId: 'user-1', status: 'OFFERED' } } }, // not nice
            event: expectedEventForRedemption
        };
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(expectedRedemptionCall);

        expect(updateBoostRedeemedStub).to.have.been.calledOnceWithExactly(['boost-id']);
    });

});

describe('*** UNIT TEST EXECUTES ALL ***', async () => {

    beforeEach(resetStubs);

    // simple coverage of the single method we use in lambda to make it a common schedule
    it('Executes all schedule based tasks at once', async () => {
        fetchActiveDynamicBoostStub.resolves([]);
        fetchActiveStandardBoostStub.resolves([]);

        const resultOfProcess = await handler.handleAllScheduledTasks();
        const expectedResult = {
            statusCode: 200,
            resultOfProcessing: {
                resultOfTimeProcessing: { boostsProcessed: 0 },
                resultOfAudienceRefreshing: { result: 'NO_BOOSTS' }
            }
        };
        expect(resultOfProcess).to.deep.equal(expectedResult);

        expect(fetchActiveDynamicBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        // rest is covered by above
    });

});
