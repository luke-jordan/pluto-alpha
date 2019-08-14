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
const updateBoostAccountStub = sinon.stub();

const momentStub = sinon.stub();

const publishStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire');

const handler = proxyquire('../boost-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'updateBoostAccountStatus': updateBoostAccountStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
    'moment': momentStub
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');
const testMktingAdmin = uuid();

describe('*** UNIT TEST BOOSTS *** Validation and error checks for insert', () => {

    it('Rejects event without authorization', async () => {
        const resultOfCall = await handler.createBoost({ boostType: 'FRAUD' });
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });
    });

    it('Rejects all categories except referrals if user is ordinary role', async () => {
        const resultOfCall = await handler.createBoost(testHelper.wrapEvent({ boostTypeCategory: 'SIMPLE::TIME_LIMITED' }, uuid(), 'ORDINARY_USER' ));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403, body: 'Ordinary users cannot create boosts'});
    });

    it('Swallows an error and return its message', async () => {
        const resultOfCall = await handler.createBoost(testHelper.wrapEvent({ badObject: 'This is bad' }));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('statusCode', 500);
    });

});

describe('*** UNIT TEST BOOSTS *** Individual or limited users', () => {

    const referralWindowEnd = moment().add(3, 'months');
    const timeSaveCompleted = moment();
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    // IDs for message templates for referrer and referred
    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const mockBoostToFromPersistence = {
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
        boostAudienceSelection: `whole_universe from #{'{"specific_users": ["${testReferringUser}","${testReferredUser}"]}'}`,
        defaultStatus: 'PENDING',
        redemptionMsgInstructions: { testReferringUser: testReferringMsgId, testReferredUser: testReferredMsgId }
    };

    it('Happy path inserting a referral-based individual boost', async () => {
        logger('About to create a referral based boost, for two users, ending at: ', referralWindowEnd);

        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(referralWindowEnd.valueOf()).returns(referralWindowEnd);

        const expectedFromRds = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 2
        };
        insertBoostStub.withArgs(sinon.match(mockBoostToFromPersistence)).resolves(expectedFromRds);

        const testBodyOfEvent = {
            boostTypeCategory: 'REFERRAL::USER_CODE_USED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: referralWindowEnd.valueOf(),
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: `whole_universe from #{'{"specific_users": ["${testReferringUser}","${testReferredUser}"]}'}`,
            initialStatus: 'PENDING',
            statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
            redemptionMsgInstructions: { testReferringUser: testReferringMsgId, testReferredUser: testReferredMsgId }
        };

        const resultOfInstruction = await handler.createBoost(testHelper.wrapEvent(testBodyOfEvent, testReferredUser, 'ORDINARY_USER'));
        // testHelper.logNestedMatches(mockRdsInstruction, insertBoostStub.getCall(0).args[0]);

        const bodyOfResult = testHelper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(expectedFromRds);
    });

    it.only('Happy path closing out a referral after referred user adds cash', async () => {
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
        findBoostStub.withArgs({ accountId: [testReferredUser], status: ['OFFERED', 'PENDING'], active: true}).resolves([boostFromPersistence]);
        findBoostStub.withArgs({ boostId: testBoostId }).resolves(mockBoostToFromPersistence);

        // then we will have to do a condition check, after which decide that the boost has been redeemed, and invoke the float allocation lambda
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            floatId: mockBoostToFromPersistence.fromFloatId,
            fromId: mockBoostToFromPersistence.fromBonusPoolId,
            currency: mockBoostToFromPersistence.boostCurrency,
            unit: mockBoostToFromPersistence.boostUnit,
            recipients: {
                testReferringUser: mockBoostToFromPersistence.boostAmount,
                restReferredUser: mockBoostToFromPersistence.boostAmount
            }
        });

        const expectedAllocationResult = {
            result: 'SUCCESS' ,
            floatTxIds: [uuid(), uuid(), uuid()],
            accountTxIds: [uuid(), uuid()]
        };

        lamdbaInvokeStub.withArgs(expectedAllocationInvocation).returns({ promise: () => testHelper.mockLambdaResponse(expectedAllocationResult)});

        // then we update the boost to being redeemed, and insert the relevant logs
        const updateProcessedTime = moment();
        const testUpdateInstruction = {
            accountId: [testReferredUser, testReferringUser],
            newStatus: 'REDEEMED',
            stillActive: false,
            logType: 'REFERRAL_REDEEMED',
            logContext: { transactionId: testSavingTxId }
        };
        updateBoostAccountStub.withArgs(testUpdateInstruction).resolves({ updatedTime: updateProcessedTime });

        // then we get the message instructions for each of the users, example within instruction:
        // message: `Congratulations! By signing up using your friend's referral code, you have earned a R10 boost to your savings`,
        // message: 'Congratulations! Busani Ndlovu has signed up to Jupiter using your referral code, earning you a R10 boost to your savings',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_assemble', true, {
            instructions: [{
                instructionId: testReferredMsgId,
                destination: testUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }, {
                instructionId: testReferredMsgId,
                destination: testUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }]
        });
        lamdbaInvokeStub.withArgs(triggerMessagesInvocation).returns({ promise: () => testHelper.mockLambdaResponse({ result: 'SUCCESS' }) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testUserId,
            context: {
                referralCodeOwner: testOriginalUserId,
                boostUpdateTimeMillis: updateProcessedTime.valueOf(),
                accountTxIds: expectedAllocationResult.accountTxIds,
                floatTxIds: expectedAllocationResult.floatTxIds
            }
        };

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
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        conditionClause: 'save_event_greater_than #{threshold}',
        statusConditions: { REDEEMED: ['save_event_greater_than #{200000:HUNDREDTH_CENT:USD}' ] },
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
        defaultStatus: 'CREATED',
        redemptionMsgInstructions: { ALL: testRedemptionMsgId }
    };

    it('Happy path creating a time-limited simple, general boost', async () => {
        logger('About to create a simple boost');

        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testNumberOfUsersInAudience = 100000;

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testNumberOfUsersInAudience
        };
        insertBoostStub.withArgs(mockBoostToFromPersistence).resolves(persistenceResult);

        const testBodyOfEvent = {
            boostTypeCategory: 'SIMPLE::TIME_LIMITED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { REDEEMED: ['save_event_greater_than #{200000:HUNDREDTH_CENT:USD}' ] },
            boostAudience: 'GENERAL',
            boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`
        };

        const resultOfInstruction = await handler.createBoost(testHelper.wrapEvent(testBodyOfEvent, testMktingAdmin, 'SYSTEM_ADMIN'));

        const bodyOfResult = testHelper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(persistenceResult);
    });

    it('Happy path awarding a boost after a user has saved enough', async () => {
        const testUserId = uuid();
        const timeSaveCompleted = moment();
        
        const testAccountId = uuid();
        const testSavingTxId = uuid();
        
        const testEvent = {
            userId: testUserId,
            eventType: 'SAVING_EVENT_COMPLETED',
            timeInMillis: timeSaveCompleted.valueOf(),
            eventContext: {
                transactionId: testSavingTxId,
                savedAmount: '5000000::HUNDREDTH_CENT::USD',
                firstSave: false
            }
        };
        
        // first, see if this account has offered or pending boosts against it
        findBoostStub.withArgs({ userId: [testUserId], status: ['OFFERED', 'PENDING'], active: true}).resolves([testBoostId]);
        findBoostStub.withArgs({ boostId: testBoostId }).resolves(mockBoostToFromPersistence);

        // then we will have to do a condition check, after which decide that the boost has been redeemed, and invoke the float allocation lambda
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            floatId: mockBoostToFromPersistence.fromFloatId,
            fromId: mockBoostToFromPersistence.fromBonusPoolId,
            currency: mockBoostToFromPersistence.boostCurrency,
            unit: mockBoostToFromPersistence.boostUnit,
            recipients: {
                testAccountId: mockBoostToFromPersistence.boostAmount
            }
        });

        const expectedAllocationResult = {
            result: 'SUCCESS' ,
            floatTxIds: [uuid(), uuid()],
            accountTxIds: [uuid()]
        };

        lamdbaInvokeStub.withArgs(expectedAllocationInvocation).returns({ promise: () => testHelper.mockLambdaResponse(expectedAllocationResult)});

        // then we update the boost to being redeemed, and insert the relevant logs
        const updateProcessedTime = moment();
        const testUpdateInstruction = {
            accountId: [testAccountId],
            newStatus: 'REDEEMED',
            stillActive: true,
            logType: 'SAVING_HURDLE_CLEARED',
            logContext: { transactionId: testSavingTxId }
        }; 
        updateBoostAccountStub.withArgs(testUpdateInstruction).resolves({ updatedTime: updateProcessedTime });

        // then we get the message instructions for each of the users, example within instruction:
        // message: 'Congratulations! We have boosted your savings by R10. Keep saving to keep earning more boosts!',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_assemble', true, {
            instructions: [{
                instructionId: testRedemptionMsgId,
                destination: testUserId,
                parameters: { boostAmount: '$20' },
                triggerBalanceFetch: true
            }]
        });
        lamdbaInvokeStub.withArgs(triggerMessagesInvocation).returns({ promise: () => testHelper.mockLambdaResponse({ result: 'SUCCESS' }) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            context: {
                boostId: testBoostId,
                boostUpdateTimeMillis: updateProcessedTime.valueOf(),
                triggeringTxId: testSavingTxId,
                savedAmount: testEvent.eventContext.savedAmount,
                accountTxIds: expectedAllocationResult.accountTxIds,
                floatTxIds: expectedAllocationResult.floatTxIds
            }
        };

        const resultOfEventRecord = await handler.processEvent(testEvent);
        logger('Result of record: ', resultOfEventRecord);

        expect(resultOfEventRecord).to.exist;

        expect(publishStub).to.be.calledWithExactly(testUserId, 'REFERRAL_REDEEMED', publishOptions);
        expect(publishStub).to.be.calledWithExactly(testOriginalUserId, 'REFERRAL_REDEEMED', publishOptions);
    });
});