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
const { stub } = require('sinon');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();
const setBoostMsgsStub = sinon.stub();

const fetchUncreatedBoostStub = sinon.stub();
const fetchRelevantBoostStub = sinon.stub();
const insertBoostAccountsStub = sinon.stub();

const fetchActiveStandardBoostStub = sinon.stub();
const fetchAccountsStub = sinon.stub();
const updateBoostStatusStub = sinon.stub();

const redeemBoostStub = sinon.stub();

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
        'insertBoostAccountJoins': insertBoostAccountsStub,
    }    
});

const scheduledHandler = proxyquire('../boost-scheduled-handler', {
    './persistence/rds.boost': {
        'fetchActiveStandardBoosts': fetchActiveStandardBoostStub,
        'findAccountsForBoost': fetchAccountsStub,
        'updateBoostAccountStatus': updateBoostStatusStub,
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

// const listHandler = proxyquire('../boost-list-handler', {
    
// });

const stubs = [fetchUncreatedBoostStub, fetchRelevantBoostStub, publishEventStub, publishMultiStub, lambdaInvokeStub];

const resetStubs = () => helper.resetStubs(...stubs);

const testBoostId = uuid();

const testStartTime = moment();
const testEndTime = moment().add(6, 'months');
const testPersistedTime = moment();

const mockAdminId = uuid();
const mockUserId = uuid();

describe('UNIT TEST WITHDRAWAL BOOST', () => {

    beforeEach(resetStubs);

    // this is the canonical form of the attempted withdrawal-thwarting boost status conditions, and boost generally

    // NB : MAKE SURE TO EXCLUDE FAILURE/EXPIRY FROM CHECK FOR BOOST CREATE (SO, NOT EXCLUDED ACCIDENTALLY)
    const testStatusConditions = { 
        OFFERED: ['event_occurs #{WITHDRAWAL_EVENT_CONFIRMED}'],
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
        statusConditions: testStatusConditions
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
                REDEEMED: ['event_does_not_follow #{WITHDRAWAL_EVENT_CANCELLED::ADMIN_SETTLED_WITHDRAWAL::30::DAYS}'],
                FAILED: ['event_occurs #{WITHDRAWAL_EVENT_CONFIRMED}']        
            },
            audienceId: 'some-audience',
            messagesToCreate: [],
            flags: ['WITHDRAWAL_STEMMING'],
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
            statusConditions: testBodyOfEvent.statusConditions,
            
            messageInstructionIds: [],
            flags: ['WITHDRAWAL_STEMMING']
        };

        expect(insertBoostStub).to.have.been.calledWith(expectedBoostRds);
    });

    it('Unit test creating withdrawal-incentive boost, post-withdrawal, with messages', async () => {

        // could also use messageInstructionIds, _but_ we really want this event in the data pipeline for later training,
        // and we may as well reuse msg trigger infrastructure right now (given constraints)

        const mockMsgTrigger = { triggerEvent: ['BOOST_OFFERED_WITHDRAWAL'] }; 
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
            flags: ['WITHDRAWAL_RELATED', 'NO_OTHER_WITHDRAWAL_RELATED']
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
    
        fetchUncreatedBoostStub.resolves([testPersistedBoost]);
        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch([testEvent]));

    });

    it('Boost is expired if no cancellation and admin goes ahead', async () => {
        const testEvent = { userId: mockUserId, eventType: 'ADMIN_SETTLED_WITHDRAWAL' };

        // find boost and then process
        fetchRelevantBoostStub.resolves([testPersistedBoost]);
    });

    it('Makes boost pending by cancelling withdrawal', async () => {
        const testEvent = { userId: mockUserId, eventType: 'WITHDRAWAL_EVENT_CANCELLED' };
        
        fetchRelevantBoostStub.resolves([testPersistedBoost]);

        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch(testEvent));

    });

    it('Boost fails by withdrawing within period', async () => {
        const testEvent = { userId: mockUserId, eventType: 'ADMIN_SETTLED_WITHDRAWAL' };

        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch(testEvent));
    });

    it('Redeems boost when crosses time threshold', async () => {

        const resultOfProcess = await scheduledHandler.processTimeBasedConditions();

    });

    it('Finds pending withdrawal boosts for user, to warn, and/or display', async () => {

        const withdrawalList = await listHandler.listEventLinkedBoosts('ADMIN_SETTLED_WITHDRAWAL');
    });

    // need to figure this out : need a way to record "do not offer these both at same time"
    // it('Boost is not created if user has one blocking it', async () => {
    
    // });    

});

