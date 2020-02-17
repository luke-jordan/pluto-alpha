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
const alterBoostStub = sinon.stub();
const updateRedeemedStub = sinon.stub();
const findAccountStub = sinon.stub();

const momentStub = sinon.stub();

const publishStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-process-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'fetchBoost': fetchBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'alterBoost': alterBoostStub,
        'updateBoostAmountRedeemed': updateRedeemedStub
    },
    './persistence/rds.admin.boost.js': {
        'findAccountsForUser': findAccountStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(
    insertBoostStub, findBoostStub, fetchBoostStub, findAccountsStub, 
    updateBoostAccountStub, alterBoostStub, publishStub, lamdbaInvokeStub, updateRedeemedStub
);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');
const testMktingAdmin = uuid();

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
        const expectedKey = { accountId: [testReferredUser], boostStatus: ['OFFERED', 'PENDING'], active: true, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        
        // then we will have to do a condition check, after which decide that the boost has been redeemed
        // and get the accounts that are affected by the redemption
        
        findAccountsStub.withArgs({ boostIds: [testBoostId], status: ['OFFERED', 'PENDING'] }).resolves([{ 
            boostId: testBoostId,
            accountUserMap: {
                [testReferredUser]: { userId: testUserId, status: 'PENDING' },
                [testReferringUser]: { userId: testOriginalUserId, status: 'PENDING' }
            }
        }]);
        
        // then we invoke the float allocation lambda
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            instructions: [{
                identifier: testBoostId,
                floatId: mockBoostToFromPersistence.fromFloatId,
                fromId: mockBoostToFromPersistence.fromBonusPoolId,
                fromType: 'BONUS_POOL',
                currency: mockBoostToFromPersistence.boostCurrency,
                unit: mockBoostToFromPersistence.boostUnit,
                transactionType: 'BOOST_REDEMPTION',
                relatedEntityType: 'BOOST_REDEMPTION',
                settlementStatus: 'SETTLED',
                allocType: 'BOOST_REDEMPTION',
                allocState: 'SETTLED',
                recipients: [
                    { recipientId: testReferredUser, amount: mockBoostToFromPersistence.boostAmount, recipientType: 'END_USER_ACCOUNT' },
                    { recipientId: testReferringUser, amount: mockBoostToFromPersistence.boostAmount, recipientType: 'END_USER_ACCOUNT' }
                ]
            }]
        });

        const expectedAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid(), uuid()],
                accountTxIds: [uuid(), uuid()]
            }
        };

        lamdbaInvokeStub.withArgs(expectedAllocationInvocation).returns({ 
            promise: () => testHelper.mockLambdaResponse(expectedAllocationResult)
        });

        // then we update the boost to being redeemed, and insert the relevant logs
        const updateProcessedTime = moment();
        const testUpdateInstruction = [{
            boostId: testBoostId,
            accountIds: [testReferredUser, testReferringUser],
            newStatus: 'REDEEMED',
            stillActive: false,
            logType: 'STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', boostAmount: 100000, transactionId: testSavingTxId }
        }];
        // logger('Expecting update instructions: ', testUpdateInstruction);
        updateBoostAccountStub.withArgs(testUpdateInstruction).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);

        // then we get the message instructions for each of the users, example within instruction:
        // message: `Congratulations! By signing up using your friend's referral code, you have earned a R10 boost to your savings`,
        // message: 'Congratulations! Busani Ndlovu has signed up to Jupiter using your referral code, earning you a R10 boost to your savings',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_user_create_once', true, {
            instructions: [{
                instructionId: testReferringMsgId,
                destinationUserId: testOriginalUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }, {
                instructionId: testReferredMsgId,
                destinationUserId: testUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }]
        });
        logger('Expected message invocation: ', triggerMessagesInvocation);
        lamdbaInvokeStub.withArgs(triggerMessagesInvocation).returns({ promise: () => testHelper.mockLambdaResponse({ result: 'SUCCESS' }) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testUserId,
            context: {
                boostId: testBoostId,
                boostUpdateTimeMillis: updateProcessedTime.valueOf(),
                transferResults: expectedAllocationResult[testBoostId],
                eventContext: testEvent.eventContext
            }
        };
        publishStub.withArgs(testUserId, 'REFERRAL_REDEEMED', sinon.match(publishOptions)).resolves({ result: 'SUCCESS' });
        publishStub.withArgs(testOriginalUserId, 'REFERRAL_REDEEMED', publishOptions).resolves({ result: 'SUCCESS' });

        const resultOfEventRecord = await handler.processEvent(testEvent);
        logger('Result of record: ', resultOfEventRecord);

        expect(resultOfEventRecord).to.exist;
        // expect(publishStub).to.be.calledWithExactly(testUserId, 'REFERRAL_REDEEMED', publishOptions);
        // expect(publishStub).to.be.calledWithExactly(testOriginalUserId, 'REFERRAL_REDEEMED', publishOptions);
    });

});

describe('*** UNIT TEST BOOSTS *** General audience', () => {

    beforeEach(() => resetStubs());

    const testRedemptionMsgId = uuid();

    const mockBoostToFromPersistence = {
        creatingUserId: testMktingAdmin,
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
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

    it('Happy path awarding a boost after a user has saved enough', async () => {
        const testUserId = uuid();
        const timeSaveCompleted = moment();
        
        const testAccountId = uuid();
        const testSavingTxId = uuid();
        const testBoostId = uuid();
        
        const testEvent = {
            accountId: testAccountId,
            eventType: 'SAVING_EVENT_COMPLETED',
            timeInMillis: timeSaveCompleted.valueOf(),
            eventContext: {
                transactionId: testSavingTxId,
                savedAmount: '5000000::HUNDREDTH_CENT::USD',
                firstSave: false
            }
        };

        const boostFromPersistence = { ...mockBoostToFromPersistence };
        boostFromPersistence.boostId = testBoostId;
        
        // first, see if this account has offered or pending boosts against it
        const expectedKey = { accountId: [testAccountId], boostStatus: ['OFFERED', 'PENDING'], active: true, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        
        const findAccountArgs = { boostIds: [testBoostId], accountIds: [testAccountId], status: ['OFFERED', 'PENDING'] };
        findAccountsStub.withArgs(findAccountArgs).resolves([{
            boostId: testBoostId,
            accountUserMap: { 
                [testAccountId]: { userId: testUserId, status: 'OFFERED' }
            }
        }]);

        // then we will have to do a condition check, after which decide that the boost has been redeemed, and invoke the float allocation lambda
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            instructions: [{
                identifier: testBoostId,
                floatId: mockBoostToFromPersistence.fromFloatId,
                fromId: mockBoostToFromPersistence.fromBonusPoolId,
                fromType: 'BONUS_POOL',
                transactionType: 'BOOST_REDEMPTION',
                relatedEntityType: 'BOOST_REDEMPTION',
                currency: mockBoostToFromPersistence.boostCurrency,
                unit: mockBoostToFromPersistence.boostUnit,
                settlementStatus: 'SETTLED',
                allocType: 'BOOST_REDEMPTION',
                allocState: 'SETTLED',
                recipients: [
                    { recipientId: testAccountId, amount: mockBoostToFromPersistence.boostAmount, recipientType: 'END_USER_ACCOUNT' }
                ]
            }]
        });

        const expectedAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid()],
                accountTxIds: [uuid()]
            }
        };

        lamdbaInvokeStub.withArgs(expectedAllocationInvocation).returns({ 
            promise: () => testHelper.mockLambdaResponse(expectedAllocationResult)
        });

        // then we update the boost to being redeemed, and insert the relevant logs
        const updateProcessedTime = moment();
        const testUpdateInstruction = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            stillActive: true,
            logType: 'STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', boostAmount: 100000, transactionId: testSavingTxId }
        }; 
        updateBoostAccountStub.withArgs([testUpdateInstruction]).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);

        // then we get the message instructions for each of the users, example within instruction:
        // message: 'Congratulations! We have boosted your savings by R10. Keep saving to keep earning more boosts!',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_user_create_once', true, {
            instructions: [{
                instructionId: testRedemptionMsgId,
                destinationUserId: testUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }]
        });
        lamdbaInvokeStub.withArgs(triggerMessagesInvocation).returns({ promise: () => testHelper.mockLambdaResponse({ result: 'SUCCESS' }) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testUserId,
            context: {
                accountId: testAccountId,
                boostAmount: '100000::HUNDREDTH_CENT::USD',
                boostId: testBoostId,
                boostType: 'SIMPLE',
                boostCategory: 'TIME_LIMITED',
                boostUpdateTimeMillis: updateProcessedTime.valueOf(),
                transferResults: expectedAllocationResult[testBoostId],
                triggeringEventContext: testEvent.eventContext
            }
        };
        publishStub.withArgs(testUserId, 'BOOST_REDEEMED', sinon.match(publishOptions)).resolves({ result: 'SUCCESS' });

        const resultOfEventRecord = await handler.processEvent(testEvent);
        logger('Result of record: ', resultOfEventRecord);
        expect(resultOfEventRecord).to.exist;
        
        expect(publishStub).to.be.calledWithExactly(testUserId, 'BOOST_REDEEMED', publishOptions);
    });

    it('Fails where event currency and status condition currency do not match', async () => {
        const testUserId = uuid();
        const timeSaveCompleted = moment();
        
        const testAccountId = uuid();
        const testSavingTxId = uuid();
        const testBoostId = uuid();
        
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
        const expectedKey = { accountId: [testAccountId], boostStatus: ['OFFERED', 'PENDING'], active: true, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        
        const findAccountArgs = { boostIds: [testBoostId], accountIds: [testAccountId], status: ['OFFERED', 'PENDING'] };
        findAccountsStub.withArgs(findAccountArgs).resolves([{
            boostId: testBoostId,
            accountUserMap: { 
                [testAccountId]: { userId: testUserId, status: 'OFFERED' }
            }
        }]);

        // then we will have to do a condition check, after which decide that the boost has been redeemed, and invoke the float allocation lambda
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            instructions: [{
                identifier: testBoostId,
                floatId: mockBoostToFromPersistence.fromFloatId,
                fromId: mockBoostToFromPersistence.fromBonusPoolId,
                fromType: 'BONUS_POOL',
                relatedEntityType: 'BOOST_REDEMPTION',
                currency: mockBoostToFromPersistence.boostCurrency,
                unit: mockBoostToFromPersistence.boostUnit,
                recipients: [
                    { recipientId: testAccountId, amount: mockBoostToFromPersistence.boostAmount, recipientType: 'END_USER_ACCOUNT' }
                ]
            }]
        });

        const expectedAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid()],
                accountTxIds: [uuid()]
            }
        };

        lamdbaInvokeStub.withArgs(expectedAllocationInvocation).returns({ 
            promise: () => testHelper.mockLambdaResponse(expectedAllocationResult)
        });

        // then we update the boost to being redeemed, and insert the relevant logs
        const updateProcessedTime = moment();
        const testUpdateInstruction = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            stillActive: true,
            logType: 'STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', boostAmount: 100000, transactionId: testSavingTxId }
        }; 
        updateBoostAccountStub.withArgs([testUpdateInstruction]).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);

        // then we get the message instructions for each of the users, example within instruction:
        // message: 'Congratulations! We have boosted your savings by R10. Keep saving to keep earning more boosts!',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_user_create_once', true, {
            instructions: [{
                instructionId: testRedemptionMsgId,
                destinationUserId: testUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }]
        });
        lamdbaInvokeStub.withArgs(triggerMessagesInvocation).returns({ promise: () => testHelper.mockLambdaResponse({ result: 'SUCCESS' }) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testUserId,
            context: {
                boostId: testBoostId,
                boostUpdateTimeMillis: updateProcessedTime.valueOf(),
                transferResults: expectedAllocationResult[testBoostId],
                eventContext: testEvent.eventContext
            }
        };

        publishStub.withArgs(testUserId, 'BOOST_REDEEMED', sinon.match(publishOptions)).resolves({ result: 'SUCCESS' });

        const resultOfEventRecord = await handler.processEvent(testEvent);
        logger('Result of record: ', resultOfEventRecord);
        expect(resultOfEventRecord).to.exist;

        expect(resultOfEventRecord).to.deep.equal({ statusCode: 200, body: JSON.stringify({ boostsTriggered: 0 })});
        
        expect(publishStub).to.have.not.been.called;
    });
});

describe('*** UNIT TEST USER BOOST RESPONSE ***', async () => {
    
    const testBoostId = uuid();
    const testUserId = uuid();
    const testAccountId = uuid();

    beforeEach(() => resetStubs());

    it('Redeems when game is won', async () => {
        const testEvent = {
            boostId: testBoostId,
            numberTaps: 20,
            timeTakenMillis: 9000
        };
    
        const boostAsRelevant = {
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'TAP_SCREEN',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            fromFloatId: 'test-float',
            fromBonusPoolId: 'test-bonus-pool',
            statusConditions: {
                REDEEMED: ['number_taps_greater_than #{10::10000}']
            }
        };

        // bit of redundancy in here, but necessary for the moment
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            instructions: [{
                identifier: testBoostId,
                allocState: 'SETTLED',
                settlementStatus: 'SETTLED',
                floatId: 'test-float',
                fromId: 'test-bonus-pool',
                fromType: 'BONUS_POOL',
                allocType: 'BOOST_REDEMPTION',
                relatedEntityType: 'BOOST_REDEMPTION',
                transactionType: 'BOOST_REDEMPTION',
                currency: 'USD',
                unit: 'HUNDREDTH_CENT',
                recipients: [
                    { recipientId: testAccountId, amount: 50000, recipientType: 'END_USER_ACCOUNT' }
                ]
            }]
        });

        fetchBoostStub.resolves(boostAsRelevant);
        findAccountStub.resolves([testAccountId]);

        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse({ [testBoostId]: { result: 'SUCCESS' }})});
        
        const mockUpdateProcessedTime = moment();
        updateBoostAccountStub.resolves([{ boostId: testBoostId, updatedTime: mockUpdateProcessedTime }]);

        const expectedResult = { 
            result: 'TRIGGERED', 
            statusMet: ['REDEEMED'], 
            amountAllocated: { amount: 50000, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };

        const result = await handler.processUserBoostResponse(testHelper.wrapEvent(testEvent, testUserId, 'ORDINARY_USER'));
        logger('Result of user boost response processing:', result);
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result.body).to.deep.equal(JSON.stringify(expectedResult));

        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedAllocationInvocation);
        
        const expectedLogContext = { submittedParams: testEvent, processType: 'USER', newStatus: 'REDEEMED', boostAmount: 50000 };
        const expectedUpdateInstruction = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            stillActive: true,
            logType: 'STATUS_CHANGE',
            logContext: expectedLogContext
        };

        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedUpdateInstruction]);
        expect(updateRedeemedStub).to.have.been.calledOnceWithExactly([testBoostId]);

        const expectedPublishOptions = {
            initiator: testUserId,
            context: {
                accountId: testAccountId,
                boostAmount: '50000::HUNDREDTH_CENT::USD',
                boostCategory: 'TAP_SCREEN',
                boostId: testBoostId,
                boostType: 'GAME',
                boostUpdateTimeMillis: mockUpdateProcessedTime.valueOf(),
                transferResults: { result: 'SUCCESS' },
                triggeringEventContext: testEvent
            }            
        };

        expect(publishStub).to.have.been.calledOnceWithExactly(testUserId, 'BOOST_REDEEMED', expectedPublishOptions);
    });

    it('Fails when not enough taps', async () => {
        const testEvent = {
            boostId: testBoostId,
            numberTaps: 8,
            timeTakenMillis: 9000
        };
    
        const boostAsRelevant = {
            boostId: testBoostId,
            statusConditions: {
                REDEEMED: ['number_taps_greater_than #{10::10000}']
            }
        };

        fetchBoostStub.resolves(boostAsRelevant);
        
        const result = await handler.processUserBoostResponse(testHelper.wrapEvent(testEvent, testUserId, 'ORDINARY_USER'));
        logger('Result of user boost response processing:', result);
        expect(result.statusCode).to.deep.equal(200);
        expect(result.body).to.deep.equal(JSON.stringify({ result: 'NO_CHANGE' }));

    });

    it('Handles test run', async () => {
        const result = await handler.processUserBoostResponse();
        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 400 });
    });

    it('Fails on missing authorization', async () => {
        const testEvent = { testParam: 'TEST_VAL' };
        const result = await handler.processUserBoostResponse(testEvent);
        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 403 });
    });

    it('Catches thrown errors', async () => {
        const testEvent = {
            body: ['BAD_BODY'],
            requestContext: {
                authorizer: {
                    systemWideUserId: testUserId,
                    userRole: 'ORDINARY_USER'
                }
            }
        };
        
        const result = await handler.processUserBoostResponse(testEvent);
        logger('Result of user boost response processing:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(500);
    });
});
