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

const fetchUncreatedBoostStub = sinon.stub();
const fetchRelevantBoostStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

// const createHandler = proxyquire('../boost-create-wrapper', {
    
// });

// const eventHandler = proxyquire('../boost-process-handler', {
    
// });

// const scheduledHandler = proxyquire('../boost-scheduled-handler', {
    
// });

// const listHandler = proxyquire('../boost-list-handler', {
    
// });

const testBoostId = uuid();
const testStartTime = moment();
const testEndTime = moment().add(6, 'months');

const mockAdminId = uuid();

describe.skip('UNIT TEST WITHDRAWAL BOOST', () => {

    // this is the canonical form of the attempted withdrawal-thwarting boost status conditions, and boost generally

    // NB : MAKE SURE TO EXCLUDE FAILURE/EXPIRY FROM CHECK FOR BOOST CREATE (SO, NOT EXCLUDED ACCIDENTALLY)
    const testStatusConditions = { 
        OFFERED: ['event_occurs #{WITHDRAWAL_EVENT_CONFIRMED}'],
        PENDING: ['event_occurs #{WITHDRAWAL_EVENT_CANCELLED}'],
        REDEEMED: ['event_does_not_follow #{WITHDRAWAL_EVENT_CANCELLED::WITHDRAWAL_EVENT_CONFIRMED::30::DAYS}'],
        FAILED: ['event_occurs #{ADMIN_SETTLED_WITHDRAWAL}'],
        FAILED: ['event_does_follow #{WITHDRAWAL_EVENT_CANCELLED::WITHDRAWAL_EVENT_CONFIRMED::30::DAYS}']
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
    }

    it('Unit test creating withdrawal-incentive boost', async () => {

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

        const testBodyOfEvent = {
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
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            messagesToCreate: [eventMessageBody]
        };
 
        insertBoostStub.resolves(mockResultFromRds);

        const testEvent = helper.wrapEvent(testBodyOfEvent, mockAdminId, 'SYSTEM_ADMIN');
        const resultOfCreation = await createHandler.createBoostWrapper(testEvent);

        // all the other stuff
    });

    it('Boost created by withdrawal confirmed, and message triggered', async () => {

        const testEvent = { userId: mockUserId, eventType: 'WITHDRAWAL_EVENT_CONFIRMED' };
    
        fetchUncreatedBoostStub.resolves([testPersistedBoost]);
        const resultOfProcess = await eventHandler.handleBatchOfQueuedEvents(helper.composeSqsBatch(testEvent));

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

