'use strict';

/**
 * Given high business importance of this specific boost, and its use of all / most of the more complex boost functions,
 * breaking pattern in this test and consolidating multiple handlers at once
 */

const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./boost.test.helper');

const { ACTIVE_BOOST_STATUS } = require('../boost.util');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();
const setBoostMsgsStub = sinon.stub();

const fetchUncreatedBoostStub = sinon.stub();
const fetchRelevantBoostStub = sinon.stub();
const insertBoostAccountsStub = sinon.stub();

const fetchActiveStandardBoostStub = sinon.stub();
const fetchAccountsStub = sinon.stub();
const getAccountIdStub = sinon.stub();
const updateBoostStatusStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();

const redeemBoostStub = sinon.stub();

const fetchUserBoostsStub = sinon.stub();
const userListAccountStub = sinon.stub();

const publishEventStub = sinon.stub();
const publishMultiStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();
const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const createHandler = proxyquire('../boost-create-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'setBoostMessages': setBoostMsgsStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishEventStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'moment': momentStub,
    '@noCallThru': true
});

const eventHandler = proxyquire('../boost-event-handler', {
    './persistence/rds.boost': {
        'fetchUncreatedActiveBoostsForAccount': fetchUncreatedBoostStub,
        'findBoost': fetchRelevantBoostStub,
        'insertBoostAccountJoins': insertBoostAccountsStub,
        'getAccountIdForUser': getAccountIdStub,
        'findAccountsForBoost': fetchAccountsStub,
        'updateBoostAccountStatus': updateBoostStatusStub
    },
    'publish-common': {
        'publishUserEvent': publishEventStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    }
});

const scheduledHandler = proxyquire('../boost-scheduled-handler', {
    './persistence/rds.boost': {
        'fetchActiveStandardBoosts': fetchActiveStandardBoostStub,
        'findAccountsForBoost': fetchAccountsStub,
        'updateBoostAccountStatus': updateBoostStatusStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        '@noCallThru': true
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redeemBoostStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    }
});

const listHandler = proxyquire('../boost-list-handler', {
    './persistence/rds.boost.list': {
        'fetchUserBoosts': fetchUserBoostsStub,
        'findAccountsForUser': userListAccountStub,
        '@noCallThru': true
    },
    'ioredis': class {
        constructor () { 
            this.get = sinon.stub();
            this.set = sinon.stub();
        }
    }
});

// AND THEN SOME STANDARD IDS

const testBoostId = uuid();

const testStartTime = moment();
const testEndTime = moment().add(6, 'months');
const testPersistedTime = moment();

const mockAdminId = uuid();
const mockUserId = uuid();

// A COUPLE OF HELPERS

const stubs = [
    insertBoostStub, fetchUncreatedBoostStub, fetchRelevantBoostStub, 
    fetchActiveStandardBoostStub, fetchAccountsStub, updateBoostStatusStub, updateBoostRedeemedStub, redeemBoostStub,
    getAccountIdStub, publishEventStub, publishMultiStub, lambdaInvokeStub
];

const resetStubs = () => helper.resetStubs(...stubs);

const mockAccountDict = (accountId, status) => ({
    boostId: testBoostId, 
    accountUserMap: {
        [accountId]: { userId: mockUserId, status }
    }
});

const setLambdaToReturnHistory = (userEvents, userId = mockUserId) => {
    const payload = {
        result: 'SUCCESS',
        [userId]: {
            totalCount: userEvents.length,
            userEvents
        }
    };
    lambdaInvokeStub.returns({ promise: () => ({ StatusCode: 200, Payload: JSON.stringify(payload) })});
};

const expectedStatusUpdate = (newStatus, accountId, logContext) => [{
    boostId: testBoostId,
    accountIds: [accountId],
    newStatus,
    stillActive: true,
    logType: 'STATUS_CHANGE',
    logContext: { newStatus, ...logContext }
}];

describe('UNIT TEST WITHDRAWAL BOOST', () => {

    beforeEach(resetStubs);

    // this is the canonical form of the attempted withdrawal-thwarting boost status conditions, and boost generally

    // NB : MAKE SURE TO EXCLUDE FAILURE/EXPIRY FROM CHECK FOR BOOST CREATE (SO, NOT EXCLUDED ACCIDENTALLY)
    const testStatusConditions = { 
        OFFERED: ['event_occurs #{WITHDRAWAL_EVENT_CONFIRMED}'],
        EXPIRED: ['event_does_follow #{WITHDRAWAL_EVENT_CONFIRMED::ADMIN_SETTLED_WITHDRAWAL::30::DAYS}'],
        PENDING: ['event_occurs #{WITHDRAWAL_EVENT_CANCELLED}'],
        REDEEMED: ['event_does_not_follow #{WITHDRAWAL_EVENT_CANCELLED::ADMIN_SETTLED_WITHDRAWAL::30::DAYS}'],
        FAILED: ['event_does_follow #{WITHDRAWAL_EVENT_CANCELLED::ADMIN_SETTLED_WITHDRAWAL::30::DAYS}']
    };
    
    const testPersistedBoost = {
        boostId: testBoostId,
        creatingUserId: mockAdminId,
        label: 'Boost avoiding withdrawal, attempt 1',
        boostType: 'WITHDRAWAL',
        boostCategory: 'CANCEL_WITHDRAWAL',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        forClientId: 'some_client_co',
        fromFloatId: 'primary_cash',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        boostAudienceType: 'EVENT_DRIVEN',
        audienceId: 'some-audience',
        messageInstructionIds: { },
        statusConditions: testStatusConditions,
        flags: ['WITHDRAWAL_HALTING']
    };

    it('Unit test creating withdrawal-incentive boost, to abort _within_ (i.e., before confirming) boost', async () => {

        // note : we have no message because this one is only displayed inside the app; in future likely will A/B test etc
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            accountIds: []
        };

        const testBodyOfEvent = {
            creatingUserId: mockAdminId,
            label: 'Boost avoiding withdrawal, attempt 1',
            boostTypeCategory: 'WITHDRAWAL::ABORT_WITHDRAWAL',
            boostAmountOffered: '50000::HUNDREDTH_CENT::USD',
            boostBudget: 100000000,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            boostAudienceType: 'EVENT_DRIVEN',
            initialStatus: 'OFFERED',
            statusConditions: {
                OFFERED: ['event_occurs #{WITHDRAWAL_EVENT_INITIATED}'],
                PENDING: ['event_occurs #{WITHDRAWAL_EVENT_CANCELLED}'],
                REDEEMED: ['event_does_not_follow #{WITHDRAWAL_EVENT_CANCELLED::WITHDRAWAL_EVENT_CONFIRMED::30::DAYS}'],
                FAILED: ['event_occurs #{WITHDRAWAL_EVENT_CONFIRMED}']        
            },
            audienceId: 'some-audience',
            messagesToCreate: [],
            flags: ['WITHDRAWAL_HALTING']
        };
 
        momentStub.returns(testStartTime.clone());
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);
        insertBoostStub.resolves(mockResultFromRds);

        const resultOfCreation = await createHandler.createBoost(testBodyOfEvent);
        expect(resultOfCreation).to.exist;

        const expectedBoostRds = {
            creatingUserId: mockAdminId,
            label: testBodyOfEvent.label,
            boostEndTime: testEndTime,
            boostStartTime: testStartTime,
            
            boostType: 'WITHDRAWAL',
            boostCategory: 'ABORT_WITHDRAWAL',
            
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_cash',
            boostAmount: 50000,
            boostBudget: testBodyOfEvent.boostBudget,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            
            defaultStatus: 'OFFERED',
            statusConditions: testBodyOfEvent.statusConditions,

            boostAudienceType: 'EVENT_DRIVEN',
            audienceId: 'some-audience',
            
            messageInstructionIds: [],
            flags: ['WITHDRAWAL_HALTING']
        };

        expect(insertBoostStub).to.have.been.calledWith(expectedBoostRds);
    });

    it('Unit test creating withdrawal-incentive boost, post-withdrawal, with messages', async () => {

        // could also use messageInstructionIds, _but_ we really want this event in the data pipeline for later training,
        // and we may as well reuse msg trigger infrastructure right now (given constraints)

        const mockMsgTrigger = { triggerEvent: ['WITHDRAWAL_BOOST_OFFERED'] }; 
        const eventMessageBody = {
            boostStatus: 'ALL',
            isMessageSequence: false,
            presentationType: 'EVENT_DRIVEN',
            template: {
                display: { type: 'EMAIL' },
                title: `No please don't`,
                body: 'Look if you do not do it then we will give you #{boostAmount}'
            },
            triggerParameters: mockMsgTrigger
        };
    
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            accountIds: []
        };

        const testEvent = {
            creatingUserId: 'admin-user',
            label: 'Boost avoiding withdrawal, attempt 1',
            boostTypeCategory: 'WITHDRAWAL::CANCEL_WITHDRAWAL',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: 10000000,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            boostAudienceType: 'EVENT_DRIVEN',
            audienceId: 'audience-id',
            messagesToCreate: [eventMessageBody],
            flags: ['WITHDRAWAL_HALTING', 'NO_OTHER_WITHDRAWAL_HALTING']
        };
 
        momentStub.returns(testStartTime.clone());
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const mockMsgInstructReturnBody = {
            processResult: 'FIRED_INSTRUCT',
            message: { instructionId: 'created-msg-instruction', creationTimeMillis: moment().valueOf() }
        };
    
        lambdaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(mockMsgInstructReturnBody) });

        insertBoostStub.resolves(mockResultFromRds);

        // todo : need to fix this in line with general message handling fixing
        const mockMsgIdDict = [{ accountId: 'ALL', status: 'ALL', msgInstructionId: 'created-msg-instruction' }];    

        const resultOfCreation = await createHandler.createBoost(testEvent);
        expect(resultOfCreation).to.exist;

        expect(insertBoostStub).to.have.been.calledOnce;
        expect(setBoostMsgsStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, false); // event driven so do not set to offered
    });

    it('Boost created by withdrawal confirmed, and message triggered', async () => {

        const testEvent = { userId: mockUserId, eventType: 'WITHDRAWAL_EVENT_CONFIRMED' };
        const mockPersistedTime = moment();
    
        getAccountIdStub.withArgs(mockUserId).resolves('account-1');
        fetchUncreatedBoostStub.withArgs('account-1').resolves([testPersistedBoost]);
        insertBoostAccountsStub.resolves({ boostIds: [testBoostId], accountIds: ['account-i1'], persistedTimeMillis: mockPersistedTime.valueOf() });

        fetchRelevantBoostStub.resolves([testPersistedBoost]);
        fetchAccountsStub.resolves([mockAccountDict('account-1', 'CREATED')]);
        updateBoostStatusStub.resolves([{ boostId: testBoostId, updatedTime: moment() }]);

        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch([testEvent]));
        expect(resultOfProcess).to.exist;

        expect(insertBoostAccountsStub).to.have.been.calledOnceWithExactly([testBoostId], ['account-1'], 'CREATED');
        
        const expectedLogContext = { boostAmount: testPersistedBoost.boostAmount, oldStatus: 'CREATED', newStatus: 'OFFERED' };
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedStatusUpdate('OFFERED', 'account-1', expectedLogContext));

        expect(publishEventStub).to.have.been.calledOnce;
        expect(publishEventStub).to.have.been.calledWith(mockUserId, 'BOOST_CREATED_WITHDRAWAL');

        expect(publishMultiStub).to.have.been.calledTwice;
        expect(publishMultiStub).to.have.been.calledWith([mockUserId], 'WITHDRAWAL_BOOST_OFFERED'); // see note below
        expect(publishMultiStub).to.have.been.calledWith([mockUserId], 'BOOST_OFFERED_WITHDRAWAL');
        expect(lambdaInvokeStub).to.not.have.been.called;
    });

    it('Boost is expired if no cancellation and admin goes ahead', async () => {
        const testEvent = { userId: mockUserId, eventType: 'ADMIN_SETTLED_WITHDRAWAL', timeInMillis: moment().valueOf() };
        getAccountIdStub.withArgs(mockUserId).resolves('account-1');

        fetchRelevantBoostStub.resolves([testPersistedBoost]);
        fetchUncreatedBoostStub.resolves([]);
        fetchAccountsStub.resolves([mockAccountDict('account-1', 'OFFERED')]);
        updateBoostStatusStub.resolves([{ boostId: testBoostId, updatedTime: moment() }]);

        const mockEventHistory = [
            {
                userId: mockUserId,
                eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
                timestamp: moment().subtract(1, 'days').valueOf()
            }
        ];

        setLambdaToReturnHistory(mockEventHistory);

        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch([testEvent]));
        expect(resultOfProcess).to.exist;

        const expectedLogContext = { boostAmount: testPersistedBoost.boostAmount, oldStatus: 'OFFERED', newStatus: 'EXPIRED' };
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedStatusUpdate('EXPIRED', 'account-1', expectedLogContext));

        // log context is covered in other places and not core to logic here
        expect(publishMultiStub).to.have.been.calledOnceWith([mockUserId], 'WITHDRAWAL_BOOST_EXPIRED');

        helper.expectNoCalls(redeemBoostStub, updateBoostRedeemedStub);
    });

    it('Makes boost pending by cancelling withdrawal', async () => {
        const mockEventTimestamp = moment().valueOf(0);
        const testEvent = { userId: mockUserId, eventType: 'WITHDRAWAL_EVENT_CANCELLED', timeInMillis: mockEventTimestamp };
        
        fetchRelevantBoostStub.resolves([testPersistedBoost]);
        fetchUncreatedBoostStub.resolves([]);
        fetchAccountsStub.resolves([mockAccountDict('account-1', 'OFFERED')]);
        updateBoostStatusStub.resolves([{ boostId: testBoostId, updatedTime: moment() }]);

        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch([testEvent]));

        expect(resultOfProcess).to.exist;

        const expectedLogContext = { boostAmount: testPersistedBoost.boostAmount, oldStatus: 'OFFERED', newStatus: 'PENDING' };
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedStatusUpdate('PENDING', 'account-1', expectedLogContext));

        // this is a little redundant but they serve different purposes, one is generic so format like the rest, the other is for
        // specific actions specific to withdrawal boosts
        expect(publishMultiStub).to.have.been.calledTwice;
        expect(publishMultiStub).to.have.been.calledWith([mockUserId], 'WITHDRAWAL_BOOST_PENDING');
        expect(publishMultiStub).to.have.been.calledWith([mockUserId], 'BOOST_PENDING_WITHDRAWAL');

        helper.expectNoCalls(lambdaInvokeStub, redeemBoostStub, updateBoostRedeemedStub);
    });

    it('Boost fails by withdrawing within period', async () => {
        const mockEventTimestamp = moment().valueOf(0);
        // somewhat stupidly, used a different naming convention for timestamp in boost processor (hence timeInMillis)
        const testEvent = { userId: mockUserId, eventType: 'ADMIN_SETTLED_WITHDRAWAL', timeInMillis: mockEventTimestamp };

        fetchRelevantBoostStub.resolves([testPersistedBoost]);
        fetchUncreatedBoostStub.resolves([]);
        fetchAccountsStub.resolves([mockAccountDict('account-1', 'PENDING')]);
        updateBoostStatusStub.resolves([{ boostId: testBoostId, updatedTime: moment() }]);

        const mockEventHistory = [
            {
                userId: mockUserId,
                eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
                timestamp: moment().subtract(10, 'days').valueOf()
            },
            {
                userId: mockUserId,
                eventType: 'WITHDRAWAL_EVENT_CANCELLED',
                timestamp: moment().subtract(5, 'days').valueOf()
            },
            {
                userId: mockUserId,
                eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
                timestamp: moment().subtract(1, 'days').valueOf()
            },
            {
                userId: mockUserId,
                eventType: 'ADMIN_SETTLED_WITHDRAWAL',
                timestamp: mockEventTimestamp
            }
        ];

        setLambdaToReturnHistory(mockEventHistory);

        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch([testEvent]));
        expect(resultOfProcess).to.exist;

        const expectedLogContext = { boostAmount: testPersistedBoost.boostAmount, oldStatus: 'PENDING', newStatus: 'FAILED' };
        expect(updateBoostStatusStub).to.have.been.calledOnceWithExactly(expectedStatusUpdate('FAILED', 'account-1', expectedLogContext));

        const expectedEventTypes = ['WITHDRAWAL_EVENT_CONFIRMED', 'ADMIN_SETTLED_WITHDRAWAL', 'WITHDRAWAL_EVENT_CANCELLED'];
        helper.testLambdaInvoke(lambdaInvokeStub, {
            FunctionName: 'user_log_reader',
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({ userId: mockUserId, eventTypes: expectedEventTypes, excludeContext: true, startDate: testStartTime.valueOf() })
        });

        // log context is covered in other places and not core to logic here
        expect(publishMultiStub).to.have.been.calledOnceWith([mockUserId], 'WITHDRAWAL_BOOST_FAILED');

        helper.expectNoCalls(redeemBoostStub, updateBoostRedeemedStub);

    });

    // most of this is tested in boost.scheduled, so just taking care of special bits here
    it('Redeems boost when crosses time threshold', async () => {
        const withdrawalAbortConditions = {
            OFFERED: ['event_occurs #{WITHDRAWAL_EVENT_INITIATED}'],
            PENDING: ['event_occurs #{WITHDRAWAL_EVENT_CANCELLED}'],
            REDEEMED: ['event_does_not_follow #{WITHDRAWAL_EVENT_CANCELLED::WITHDRAWAL_EVENT_CONFIRMED::30::DAYS}'],
            FAILED: ['event_occurs #{WITHDRAWAL_EVENT_CONFIRMED}']        
        };
        
        const mockBoostToRedeem = { 
            ...testPersistedBoost, 
            statusConditions: withdrawalAbortConditions,
            boostStartTime: moment().subtract(120, 'days')
        };

        fetchActiveStandardBoostStub.resolves([mockBoostToRedeem]);
        fetchAccountsStub.resolves([mockAccountDict('account-1', 'OFFERED')]);

        // note : in future will want to come back and tighten this up to make sure doesn't count old events
        const mockEventHistory = [
            // {
            //     userId: 'user-1',
            //     eventType: 'WITHDRAWAL_EVENT_CANCELLED',
            //     timestamp: moment().subtract(50, 'days').valueOf()
            // },
            // {
            //     userId: 'user-1',
            //     eventType: 'WITHDRAWAL_EVENT_CONFIRMED',
            //     timestamp: moment().subtract(45, 'days').valueOf()
            // },
            {
                userId: mockUserId,
                eventType: 'WITHDRAWAL_EVENT_CANCELLED',
                timestamp: moment().subtract(31, 'days').valueOf()
            }
        ];
        
        setLambdaToReturnHistory(mockEventHistory);

        redeemBoostStub.resolves({
            [testBoostId]: {
                result: 'SUCCESS',
                boostAmount: 15000,
                amountFromBonus: 15000,
                floatTxIds: ['some-float-tx-id'],
                accountTxIds: ['some-account-tx-id']
            }
        });

        const resultOfProcess = await scheduledHandler.processTimeBasedConditions();
        expect(resultOfProcess).to.deep.equal({ boostsProcessed: 1, boostsTriggered: 1, accountsUpdated: 1 });        

        expect(fetchActiveStandardBoostStub).to.have.been.calledOnceWithExactly();
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly({ boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS });

        const expectedLogContext = { 
            oldStatus: 'OFFERED', 
            newStatus: 'REDEEMED',
            boostAmount: 15000, 
            amountFromBonus: 15000,
            floatTxIds: ['some-float-tx-id'],
            accountTxIds: ['some-account-tx-id'],        
            eventHistory: mockEventHistory
        };

        const expectedUpdate = expectedStatusUpdate('REDEEMED', 'account-1', expectedLogContext);
        Reflect.deleteProperty(expectedUpdate[0], 'stillActive'); // not relevant here
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
            affectedAccountsDict: { [testBoostId]: { 'account-1': { userId: mockUserId, status: 'OFFERED', newStatus: 'REDEEMED' } } },
            event: expectedEventForRedemption
        };
        expect(redeemBoostStub).to.have.been.calledOnceWithExactly(expectedRedemptionCall);

        expect(updateBoostRedeemedStub).to.have.been.calledOnceWithExactly([testBoostId]);

    });

    it('Finds pending withdrawal boosts for user, to warn, and/or display', async () => {
        const excludedStatus = ['REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED']; // starting to grandfather in FAILED
        userListAccountStub.resolves(['account-1']);
        fetchUserBoostsStub.resolves([{ boostId: 'some-boost' }]);

        const apiEvent = helper.wrapQueryParamEvent({ flag: 'WITHDRAWAL_HALTING', onlyActive: true }, mockUserId, 'ORDINARY_USER');
        const resultOfListing = await listHandler.listUserBoosts(apiEvent);
        
        const bodyOfResult = helper.standardOkayChecks(resultOfListing);
        expect(bodyOfResult).to.deep.equal([{ boostId: 'some-boost'}]);

        expect(fetchUserBoostsStub).to.have.been.calledOnce;
        expect(fetchUserBoostsStub).to.have.been.calledWith('account-1', { flags: ['WITHDRAWAL_HALTING'], excludedStatus });

    });

    // need to figure this out : need a way to record "do not offer these both at same time"
    // it('Boost is not created if user has one blocking it', async () => {
    
    // });    

});

