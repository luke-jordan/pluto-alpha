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
const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const alterBoostStub = sinon.stub();

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
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'alterBoost': alterBoostStub
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

const resetStubs = () => testHelper.resetStubs(insertBoostStub, findBoostStub, findAccountsStub, updateBoostAccountStub, alterBoostStub);

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
        messageInstructionIds: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: [ 'REDEEM_ALL_AT_ONCE' ]
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

        logger('**** COPY');
        logger(JSON.stringify(testEvent));

        const boostFromPersistence = JSON.parse(JSON.stringify(mockBoostToFromPersistence));
        boostFromPersistence.boostId = testBoostId;

        // first, see if this account has offered or pending boosts against it
        findBoostStub.withArgs({ accountId: [testReferredUser], boostStatus: ['OFFERED', 'PENDING'], active: true}).resolves([boostFromPersistence]);
        findBoostStub.withArgs({ boostId: testBoostId }).resolves(mockBoostToFromPersistence);

        // then we will have to do a condition check, after which decide that the boost has been redeemed
        // and get the accounts that are affected by the redemption
        
        // todo : status
        findAccountsStub.withArgs({ boostIds: [testBoostId], status: ['PENDING'] }).resolves([{ 
            boostId: testBoostId,
            accountUserMap: {
                [testReferredUser]: testUserId,
                [testReferringUser]: testOriginalUserId
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
                relatedEntityType: 'BOOST_REDEMPTION',
                recipients: [
                    { recipientId: testReferredUser, amount: mockBoostToFromPersistence.boostAmount, recipientType: 'END_USER_ACCOUNT' },
                    { recipientId: testReferringUser, amount: mockBoostToFromPersistence.boostAmount, recipientType: 'END_USER_ACCOUNT' }
                ]
            }]
        });

        const expectedAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS' ,
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
            logContext: { newStatus: 'REDEEMED', transactionId: testSavingTxId }
        }];
        // logger('Expecting update instructions: ', testUpdateInstruction);
        updateBoostAccountStub.withArgs(testUpdateInstruction).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);

        // then we get the message instructions for each of the users, example within instruction:
        // message: `Congratulations! By signing up using your friend's referral code, you have earned a R10 boost to your savings`,
        // message: 'Congratulations! Busani Ndlovu has signed up to Jupiter using your referral code, earning you a R10 boost to your savings',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_user_create', true, {
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
        expect(publishStub).to.be.calledWithExactly(testUserId, 'REFERRAL_REDEEMED', publishOptions);
        expect(publishStub).to.be.calledWithExactly(testOriginalUserId, 'REFERRAL_REDEEMED', publishOptions);
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
        statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}' ] },
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
        defaultStatus: 'CREATED',
        messageInstructionIds: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId, status: 'REDEEMED' }]
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

        const boostFromPersistence = JSON.parse(JSON.stringify(mockBoostToFromPersistence));
        boostFromPersistence.boostId = testBoostId;
        
        // first, see if this account has offered or pending boosts against it
        findBoostStub.withArgs({ accountId: [testAccountId], boostStatus: ['OFFERED', 'PENDING'], active: true}).resolves([boostFromPersistence]);
        
        const findAccountArgs = { boostIds: [testBoostId], accountIds: [testAccountId], status: ['PENDING'] };
        findAccountsStub.withArgs(findAccountArgs).resolves([{
            boostId: testBoostId,
            accountUserMap: { [testAccountId]: testUserId }
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
                result: 'SUCCESS' ,
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
            logContext: { newStatus: 'REDEEMED', transactionId: testSavingTxId }
        }; 
        updateBoostAccountStub.withArgs([testUpdateInstruction]).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);

        // then we get the message instructions for each of the users, example within instruction:
        // message: 'Congratulations! We have boosted your savings by R10. Keep saving to keep earning more boosts!',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_user_create', true, {
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
        publishStub.withArgs(testUserId, 'SIMPLE_REDEEMED', sinon.match(publishOptions)).resolves({ result: 'SUCCESS' });

        const resultOfEventRecord = await handler.processEvent(testEvent);
        logger('Result of record: ', resultOfEventRecord);
        expect(resultOfEventRecord).to.exist;

        expect(publishStub).to.be.calledWithExactly(testUserId, 'SIMPLE_REDEEMED', publishOptions);
    });
});