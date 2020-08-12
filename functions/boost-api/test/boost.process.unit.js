'use strict';

const logger = require('debug')('jupiter:boosts:test');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();
const findBoostStub = sinon.stub();
const fetchBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();
const alterBoostStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();

const getAccountIdForUserStub = sinon.stub();
const fetchUncreatedBoostsStub = sinon.stub();
const insertBoostAccountsStub = sinon.stub();
const insertBoostLogStub = sinon.stub();
const findPooledAccountsStub = sinon.stub();

const momentStub = sinon.stub();

const publishStub = sinon.stub();
const publishMultiStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-event-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'fetchBoost': fetchBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        'alterBoost': alterBoostStub,
        'getAccountIdForUser': getAccountIdForUserStub,
        'fetchUncreatedActiveBoostsForAccount': fetchUncreatedBoostsStub,
        'insertBoostAccountJoins': insertBoostAccountsStub,
        'insertBoostAccountLogs': insertBoostLogStub,
        'findAccountsForPooledReward': findPooledAccountsStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    'publish-common': {
        'publishUserEvent': publishStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

// note: these are not originally from SNS, hence only single-wrapper
const wrapEventAsSqs = (event) => testHelper.composeSqsBatch([event]);

const resetStubs = () => testHelper.resetStubs(
    insertBoostStub, findBoostStub, fetchBoostStub, findAccountsStub, 
    updateBoostAccountStub, alterBoostStub, publishStub, 
    getAccountIdForUserStub, fetchUncreatedBoostsStub, insertBoostAccountsStub
);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');
const testMktingAdmin = uuid();

const expectedStatusCheck = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

describe('*** UNIT TEST BOOST PROCESSING *** Individual or limited users', () => {

    const referralWindowEnd = moment().add(3, 'months');
    const timeSaveCompleted = moment();
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    // IDs for message templates for referrer and referred
    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const mockBoostToFromPersistence = {
        creatingUserId: uuid(),
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: referralWindowEnd,
        statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection: `whole_universe from #{'{"specific_accounts": ["${testReferringUser}","${testReferredUser}"]}'}`,
        defaultStatus: 'PENDING',
        messageInstructions: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    it('Happy path closing out a referral after referred user adds cash', async () => {
        logger('Testing instruction received to redeem the boost, as a result of referred user making first save');
        const testUserId = uuid();
        const testOriginalUserId = uuid(); // i.e., referrer

        const testBoostId = uuid();
        const testSavingTxId = uuid();

        // this will be invoked only by other lambdas, never directly, and is likely to involve just a user ID
        const testEvent = {
            accountId: testReferredUser,
            eventType: 'SAVING_EVENT_COMPLETED',
            timeInMillis: timeSaveCompleted.valueOf(),
            eventContext: {
                transactionId: testSavingTxId,
                savedAmount: '5000000::HUNDREDTH_CENT::USD',
                firstSave: true
            }
        };

        const boostFromPersistence = JSON.parse(JSON.stringify(mockBoostToFromPersistence));
        boostFromPersistence.boostId = testBoostId;

        // first, see if this account has offered or pending boosts against it
        const expectedKey = { accountId: [testReferredUser], boostStatus: expectedStatusCheck, active: true, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        fetchUncreatedBoostsStub.resolves([]);
        
        // then we will have to do a condition check, after which decide that the boost has been redeemed
        // and get the accounts that are affected by the redemption
        findAccountsStub.withArgs({ boostIds: [testBoostId], status: expectedStatusCheck }).resolves([{ 
            boostId: testBoostId,
            accountUserMap: {
                [testReferredUser]: { userId: testUserId, status: 'PENDING' },
                [testReferringUser]: { userId: testOriginalUserId, status: 'PENDING' }
            }
        }]);

        // then we update the boost statuses
        const updateProcessedTime = moment();
        const testUpdateInstruction = [{
            boostId: testBoostId,
            accountIds: [testReferredUser, testReferringUser],
            newStatus: 'REDEEMED',
            stillActive: false,
            logType: 'STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', boostAmount: 100000, transactionId: uuid() }
        }];
        // logger('Expecting update instructions: ', testUpdateInstruction);
        updateBoostAccountStub.withArgs(testUpdateInstruction).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);
        
        // then we hand over to the boost redemption handler, which does a lot of stuff
        redemptionHandlerStub.resolves({ [testBoostId]: { result: 'SUCCESS' }});

        const resultOfEventRecord = await handler.handleBatchOfQueuedEvents(wrapEventAsSqs(testEvent));
        logger('Result of record: ', resultOfEventRecord);

        expect(resultOfEventRecord).to.exist;
        // expect(publishStub).to.be.calledWithExactly(testUserId, 'REFERRAL_REDEEMED', publishOptions);
        // expect(publishStub).to.be.calledWithExactly(testOriginalUserId, 'REFERRAL_REDEEMED', publishOptions);
    });

});

describe('*** UNIT TEST BOOSTS *** General audience', () => {

    beforeEach(() => resetStubs());

    const testRedemptionMsgId = uuid();
    const testBoostId = uuid();

    const mockBoostToFromPersistence = {
        creatingUserId: testMktingAdmin,
        boostType: 'SIMPLE',
        boostCategory: 'SIMPLE_SAVE',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}'] },
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
        defaultStatus: 'CREATED',
        messageInstructions: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId, status: 'REDEEMED' }]
    };

    const boostCreatedByEvent = {
        boostId: testBoostId,
        creatingUserId: testMktingAdmin,
        boostType: 'SIMPLE',
        boostCategory: 'SIMPLE_SAVE',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: {
            OFFERED: ['event_occurs #{USER_CREATED_ACCOUNT}'],
            UNLOCKED: ['event_occurs #{USER_CREATED_ACCOUNT}'],
            REDEEMED: ['number_taps_greater_than #{10::10000}']
        },
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
        defaultStatus: 'CREATED',
        messageInstructions: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId, status: 'REDEEMED' }]
    };

    it('Happy path awarding a boost after a user has saved enough', async () => {
        const testLogId = uuid();
        const testUserId = uuid();
        const timeSaveCompleted = moment();
        const mockPersistedTime = moment();
        
        const testAccountId = uuid();
        const testSavingTxId = uuid();

        const pooledAccountIds = [uuid(), uuid(), uuid(), uuid()];
        const pooledContribObject = { boostId: testBoostId, accountIds: pooledAccountIds };
        
        const testEvent = {
            accountId: testAccountId,
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            timeInMillis: timeSaveCompleted.valueOf(),
            eventContext: {
                transactionId: testSavingTxId,
                savedAmount: '5000000::HUNDREDTH_CENT::USD',
                firstSave: false
            }
        };

        const boostFromPersistence = { ...mockBoostToFromPersistence };
        boostFromPersistence.boostId = testBoostId;
        boostFromPersistence.rewardParameters = {
            rewardType: 'POOLED',
            poolContributionPerUser: { amount: 20000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            additionalBonusToPool: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            percentPoolAsReward: 0.05
        };
        
        // first, see if this account has offered or pending boosts against it
        const expectedKey = { accountId: [testAccountId], boostStatus: expectedStatusCheck, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        fetchUncreatedBoostsStub.resolves([boostCreatedByEvent, boostCreatedByEvent]);
        insertBoostAccountsStub.resolves({ boostIds: [testBoostId], accountIds: [testAccountId], persistedTimeMillis: mockPersistedTime.valueOf() });

        redemptionHandlerStub.resolves([{ transferTransactionId: 'some-id' }]);

        const findAccountArgs = { boostIds: [testBoostId], accountIds: [testAccountId], status: expectedStatusCheck };
        const mockAccountUserMap = { 
            [testAccountId]: { userId: testUserId, status: 'OFFERED' }
        }; 
        findAccountsStub.withArgs(findAccountArgs).resolves([{
            boostId: testBoostId,
            accountUserMap: mockAccountUserMap
        }]);

        findPooledAccountsStub.resolves(pooledContribObject);

        insertBoostLogStub.resolves([{ logId: testLogId, creationTime: mockPersistedTime }]);

        // then we will have to do a condition check, after which decide that the boost has been redeemed, and invoke the floa
        const resultOfEventRecord = await handler.handleBatchOfQueuedEvents(wrapEventAsSqs(testEvent));
        logger('Result of record: ', resultOfEventRecord);

        expect(resultOfEventRecord).to.exist;

        const expectedAccountDict = { 
            [testBoostId]: { [testAccountId]: { userId: testUserId, status: 'OFFERED', newStatus: 'REDEEMED' } }
        };

        const expectedRedemptionCall = { 
            redemptionBoosts: [boostFromPersistence], 
            revocationBoosts: [], 
            affectedAccountsDict: expectedAccountDict,
            pooledContributionMap: { [testBoostId]: pooledAccountIds },
            event: testEvent
        };

        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(expectedRedemptionCall);
        expect(updateBoostRedeemedStub).to.have.been.calledOnceWithExactly([testBoostId]);

        expect(fetchUncreatedBoostsStub).to.have.been.calledOnceWithExactly(testAccountId);
        
        expect(findPooledAccountsStub).to.have.been.calledOnceWithExactly(testBoostId, 'BOOST_POOL_CONTRIBUTION');
        expect(insertBoostAccountsStub).to.have.not.been.called;
        expect(getAccountIdForUserStub).to.have.not.been.called;
    });

    it('Creates and unlocks boost on account opened, extracts account id for user id where not provided', async () => {
        const testUserId = uuid();
        const timeSaveCompleted = moment();
        const mockPersistedTime = moment();
        
        const testAccountId = uuid();
        
        const testEvent = {
            userId: testUserId,
            eventType: 'USER_CREATED_ACCOUNT',
            timeInMillis: timeSaveCompleted.valueOf()
        };
        
        // first, see if this account has offered or pending boosts against it
        getAccountIdForUserStub.withArgs(testUserId).resolves(testAccountId);

        fetchUncreatedBoostsStub.resolves([boostCreatedByEvent]);
        insertBoostAccountsStub.resolves({ boostIds: [testBoostId], accountIds: [testAccountId], persistedTimeMillis: mockPersistedTime.valueOf() });
        
        const expectedKey = { accountId: [testAccountId], boostStatus: expectedStatusCheck, underBudgetOnly: true };
        findBoostStub.resolves([boostCreatedByEvent]);
        
        const findAccountArgs = { boostIds: [testBoostId], accountIds: [testAccountId], status: expectedStatusCheck };
        findAccountsStub.withArgs(findAccountArgs).resolves([{
            boostId: testBoostId,
            accountUserMap: { 
                [testAccountId]: { userId: testUserId, status: 'CREATED' }
            }
        }]);

        // then we update the boost to being redeemed, and insert the relevant logs
        const updateProcessedTime = moment();
        updateBoostAccountStub.resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);

        const resultOfEventRecord = await handler.handleBatchOfQueuedEvents(wrapEventAsSqs(testEvent));
        // logger('Result of record: ', resultOfEventRecord);

        expect(resultOfEventRecord).to.exist;
        
        expect(fetchUncreatedBoostsStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(insertBoostAccountsStub).to.have.been.calledOnceWithExactly([testBoostId], [testAccountId], 'CREATED');
        expect(getAccountIdForUserStub).to.have.been.calledOnceWithExactly(testUserId);
        
        expect(findBoostStub).to.have.been.calledOnceWithExactly(expectedKey);
        
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([{
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'UNLOCKED',
            stillActive: true,
            logType: 'STATUS_CHANGE',
            logContext: { boostAmount: boostCreatedByEvent.boostAmount, newStatus: 'UNLOCKED', oldStatus: 'CREATED' }
        }]);

        expect(publishStub).to.have.been.calledOnce; // for created
        expect(publishStub).to.have.been.calledWith(testUserId, 'BOOST_CREATED_SIMPLE');
        
        expect(publishMultiStub).to.have.been.calledTwice; // because multiple users may be triggered
        expect(publishMultiStub).to.have.been.calledWith([testUserId], 'BOOST_OFFERED_SIMPLE');
        expect(publishMultiStub).to.have.been.calledWith([testUserId], 'BOOST_UNLOCKED_SIMPLE');
    });

    it('Does not create boost where it is the wrong event (even if other conditions pass)', async () => {
        const testAccountId = uuid();

        const testEvent = { 
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            accountId: testAccountId,
            eventContext: { 
                accountId: testAccountId,
                bankReference: 'ABRIJMOHUN19-00197',
                firstSave: false,
                saveCount: 92,
                savedAmount: '250000::HUNDREDTH_CENT::ZAR',
                timeInMillis: moment().valueOf(),
                transactionId: '013cc85e-1aa2-4654-9e67-2d43a337e8d3' 
            } 
        };
        
        const mockBoost = { ...boostCreatedByEvent };
        mockBoost.statusConditions = {
            PENDING: ['number_taps_greater_than #{0::15000}'], 
            REDEEMED: ['number_taps_in_first_N #{1::15000}'], 
            UNLOCKED: ['save_event_greater_than #{25::WHOLE_CURRENCY::ZAR}']
        };

        fetchUncreatedBoostsStub.resolves([mockBoost]);
        findBoostStub.resolves([]);

        const resultOfEventRecord = await handler.handleBatchOfQueuedEvents(wrapEventAsSqs(testEvent));
        logger('Result of record: ', resultOfEventRecord);

        expect(insertBoostAccountsStub).to.not.have.been.called;
    });

    it('Fails where event currency and status condition currency do not match', async () => {
        const testUserId = uuid();
        const timeSaveCompleted = moment();
        
        const testAccountId = uuid();
        const testSavingTxId = uuid();
        
        const testEvent = {
            accountId: testAccountId,
            eventType: 'SAVING_EVENT_COMPLETED',
            timeInMillis: timeSaveCompleted.valueOf(),
            eventContext: {
                transactionId: testSavingTxId,
                savedAmount: '5000000::HUNDREDTH_CENT::ZAR',
                firstSave: false
            }
        };

        const boostFromPersistence = { ...mockBoostToFromPersistence };
        boostFromPersistence.boostId = testBoostId;
        
        // first, see if this account has offered or pending boosts against it
        const expectedKey = { accountId: [testAccountId], boostStatus: expectedStatusCheck, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        fetchUncreatedBoostsStub.resolves([]);
        
        const findAccountArgs = { boostIds: [testBoostId], accountIds: [testAccountId], status: expectedStatusCheck };
        findAccountsStub.withArgs(findAccountArgs).resolves([{
            boostId: testBoostId,
            accountUserMap: { 
                [testAccountId]: { userId: testUserId, status: 'OFFERED' }
            }
        }]);

        const resultOfEventRecord = await handler.handleBatchOfQueuedEvents(wrapEventAsSqs(testEvent));
        expect(resultOfEventRecord).to.exist;
        expect(resultOfEventRecord).to.deep.equal([{ boostsTriggered: 0 }]);
        
        expect(publishStub).to.have.not.been.called;
    });
});
