'use strict';

const helper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');
const { expect } = require('chai');

const fetchActiveDynamicBoostStub = sinon.stub();
const fetchActiveStandardBoostStub = sinon.stub();

const findNewAudienceMembersStub = sinon.stub();
const insertBoostAccountsStub = sinon.stub();

const fetchAccountsStub = sinon.stub();
const fetchUserIdsStub = sinon.stub();

const redeemBoostStub = sinon.stub();
const updateBoostStatusStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const publishSingleEventStub = sinon.stub();
const publishMultiEventStub = sinon.stub();

const handler = proxyquire('../boost-scheduled-handler', {
    './persistence/rds.boost': {
        'fetchBoostsWithDynamicAudiences': fetchActiveDynamicBoostStub,
        'fetchActiveStandardBoosts': fetchActiveStandardBoostStub,
        'fetchNewAudienceMembers': findNewAudienceMembersStub,
        'insertBoostAccount': insertBoostAccountsStub,
        'findAccountsForBoost': fetchAccountsStub,
        'findUserIdsForAccounts': fetchUserIdsStub,
        'updateBoostAccountStatus': updateBoostStatusStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    'publish-common': {
        'publishUserEvent': publishSingleEventStub
    },
    'aws-sdk': {
        'Lambda': class {
            constructor() { this.invoke = lambdaInvokeStub }
        }
    }
});

const resetStubs = helper.resetStubs(fetchActiveDynamicBoostStub, findNewAudienceMembersStub, insertBoostAccountsStub, fetchUserIdsStub, lambdaInvokeStub);

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
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, result: 'NO_BOOSTS' });
        
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
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, result: 'BOOSTS_REFRESHED', boostsRefreshed: 1, newOffers: 0 });

        expect(fetchActiveDynamicBoostStub).to.have.been.calledOnceWithExactly();
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(refreshInvocation(audienceId));
        expect(findNewAudienceMembersStub).to.have.been.calledOnceWithExactly('boost-id', 'audience-id');

        helper.expectNoCalls(insertBoostAccountsStub, fetchUserIdsStub);
    });

    it('Process dynamic boost, new audience members', async () => {
        const mockBoost = {
            boostId: 'boost-id',
            creatingUserId: 'creator-id',
            boostType: 'SOCIAL',

            boostStartTime: moment(),
            boostEndTime: moment().add(6, 'months'),

            audienceId: 'audience-id',
            initialStatus: 'OFFERED',

            statusConditions: {
                REDEEMED: ['total_number_friends #{5::INITIATED}']
            },

            messageInstructionIds: {
                OFFERED: ['instruction-1', 'instruction-2']
            }
        };

        fetchActiveDynamicBoostStub.resolves([mockBoost]);

        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200 })}); // message creation instruction is async

        findNewAudienceMembersStub.resolves(['account-1', 'account-2']);
        fetchUserIdsStub.resolves(['user-2']);

        const resultOfProcess = await handler.refreshDynamicAudienceBoosts();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, result: 'BOOSTS_REFRESHED', boostsRefreshed: 1, newOffers: 0 });

        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(refreshInvocation(audienceId));

        expect(insertBoostAccountsStub).to.have.been.calledOnceWithExactly();

        expect(fetchUserIdsStub).to.have.been.calledOnceWithExactly(['account-1', 'account-2']);

        const expectedMessageParameters = { boostAmount: '$10' };

        const msgInstructionPayload = (instructionId, destinationUserId) = { 
            instructionId, 
            destinationUserId,
            parameters: expectedMessageParameters
        };

        const msgInvocation = {
            FunctionName: 'message_user_create',
            InvocationType: 'Event', // make sure idempotent ...
            Payload: JSON.stringify({
                instructions: [msgInstructionPayload('instruction-1', 'user-2'), msgInstructionPayload('instruction-2', 'user-2')]
            })
        };

        expect(lambdaInvokeStub).to.have.been.calledWithExactly(msgInvocation);

        const expectedUserLogOptions = {
            initiator: 'creator-id',
            context: {
                boostType: 'SOCIAL', 
                boostCategory: 'ADD_FRIEND', 
                boostId: 'boost-id',
                boostAmount: 100,
                boostUnit: 'WHOLE_CURRENCY',
                boostCurrency: 'USD',
                boostStartTime: mockBoost.boostStartTime.valueOf(), 
                boostEndTime: mockBoost.boostEndTime.valueOf(), 
                statusConditions: mockBoost.statusConditions,
                gameParams: undefined,
                rewardParameters: undefined,
            }
        };

        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(['user-2'], 'BOOST_CREATED_SOCIAL', expectedUserLogOptions);
    });

});

describe('*** UNIT TEST CHECKING FOR TIME-BASED CONDITIONS ***', async () => {

    const testStatusConditions = { 
        UNLOCKED: ['event_does_not_follow #{SAVING_EVENT_SUCCESSFUL::ADMIN_SETTLED_WITHDRAWAL::90::DAYS}'],
        FAILED: ['event_does_follow #{SAVING_EVENT_SUCCESSFUL::ADMIN_SETTLED_WITHDRAWAL::90::DAYS}']
    };

    const nonTimeBasedCondition = {
        REDEEMED: ['save_event_greater_than #{100::WHOLE_CURRENCY::EUR}']
    };

    const mockBoost = (statusConditions) => ({
        boostId: 'boost-id',
        statusConditions        
    });

    // weird nesting a little code smell, to fix in auth later
    const setLambdaToReturn = (userEvents) => {
        const payload = {
            result: 'SUCCESS',
            userEvents: {
                totalCount: userEvents.length,
                userEvents
            }
        }
        lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200, Payload: JSON.stringify(payload) })})
    };

    const expectedUpdateInstruction = (newStatus, accountId, logContext) = [{
        boostId: testBoostId,
        accountIds: [accountId],
        newStatus,
        logType: 'STATUS_CHANGE'
    }];

    it('Scans active boost-account pairs for time based conditions expiring', async () => {

        // First we fetch all currently active non-friend boosts. Note: two alternatives for this:
        // (i) we could stick a flag on any boost with one of these conditions, and search by that, or
        // (ii) we could do a deep search through the status conditions looking for a sequence condition
        // but (i) would be fragile (somewhere the flag doesn't get added and ...), and (ii) would be hyper complex
        // since there are unlikely to be more than, ~20-30 non-friend-tournament boosts at any time, can handle this way

        fetchActiveStandardBoostStub.resolves([mockBoost(nonTimeBasedCondition)]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, boostsProcessed: 0 });

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        helper.expectNoCalls(fetchAccountsStub, updateBoostStatusStub, redeemBoostStub);
    });

    it('Executes conditions accordingly if any such found, but no account matches conditions', async () => {

        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves(['account-1']);
        fetchUserIdsStub.resolves(['user-1']);

        setLambdaToReturn([]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, boostsProcessed: 1, boostsTriggered: 0 });

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly({ boostId: ['boost-id'] });

        helper.expectNoCalls(updateBoostStatusStub, redeemBoostStub);
    });

    it('Does nothing if one event is present but not expired or none other', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves(['account-1']);
        fetchUserIdsStub.resolves(['user-1']);

        setLambdaToReturn([
            {
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(20, 'days').valueOf()
            }
        ]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 0 });
        
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly({ boostId: ['boost-id'] });

        helper.expectNoCalls(updateBoostStatusStub, redeemBoostStub); 
    });

    // note : this is all going to be quite expensive, so probably only run once a day
    it('Executes conditions and flips status up', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves(['account-1']);
        fetchUserIdsStub.resolves(['user-1']);

        setLambdaToReturn([
            {
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(91, 'days').valueOf()
            }
        ]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });
        
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly({ boostId: ['boost-id'] });

        const expectedUpdate = expectedUpdateInstruction('UNLOCKED', 'account-1', { newStatus: 'UNLOCKED' });
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedUpdate);

        helper.expectNoCalls(redeemBoostStub);

    });

    it('Flips to failed if first event found, but second is also present', async () => {
        fetchActiveStandardBoostStub.resolves([mockBoost(testStatusConditions)]);
        fetchAccountsStub.resolves(['account-1']);
        fetchUserIdsStub.resolves(['user-1']);

        setLambdaToReturn([
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
        ]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });
        
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly({ boostId: ['boost-id'] });

        const expectedUpdate = expectedUpdateInstruction('FAILED', 'account-1', { newStatus: 'FAILED' });
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedUpdate);

        helper.expectNoCalls(redeemBoostStub); 
    });

    it('Redeems the boost if condition passes', async () => {
        const redemptionConditions = {
            REDEEMED: testStatusConditions.UNLOCKED
        };

        // this thing is a bit of a lesson in prematurely optimizing for significant parallelization, to detriment of readability
        // (was born from designing to redeem a lot of boosts + accounts simultaneously, which now it's clear is very unlikely to happen)
        const mockAccountDict = {
            'account-1': { userId: 'user-1', status: 'OFFERED' }
        };
        
        fetchActiveStandardBoostStub.resolves([mockBoost(redemptionConditions)]);
        fetchAccountsStub.resolves(mockAccountDict);

        setLambdaToReturn([
            {
                userId: 'user-1',
                eventType: 'SAVING_EVENT_SUCCESSFUL',
                timestamp: moment().subtract(91, 'days').valueOf()
            }
        ]);

        const resultOfProcess = await handler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ statusCode: 200, boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });        

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly({ boostId: ['boost-id'] });

        const expectedLogContext = { newStatus: 'REDEEMED', boostAmount: 15000, transactionId: uuid() };
        const expectedUpdate = expectedUpdateInstruction('REDEEMED', 'account-1', expectedLogContext);
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedUpdate);
    
        const expectedRedemptionCall = { 
            redemptionBoosts: [mockBoost(redemptionConditions)], 
            revocationBoosts: [],
            affectedAccountsDict: { ['boost-id']: { ...mockAccountDict }},
        };
        expect(redeemBoostStub).to.have.been.calledOnceWithExactly(expectedRedemptionCall);

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
        expect(resultOfProcess).to.deep.equal({ statusCode: 200 });

        expect(fetchActiveDynamicBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        // rest is covered by above
    });

});
