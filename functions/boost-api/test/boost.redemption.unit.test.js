'use strict';

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const publishStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-redemption-handler', {
    './persistence/rds.boost': {
        'updateBoostAmountRedeemed': updateRedeemedStub,
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
});

describe('*** UNIT TEST BOOST REDEMPTION OPERATIONS', () => {

    beforeEach(() => testHelper.resetStubs(lamdbaInvokeStub, publishStub));

    it('Redeem a referral boost', async () => {
        
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

        const resultOfRedemption = await handler.redeemBoost();

        expect(resultOfRedemption).to.exist;
    });

    it('Redeem a simple boost, from user saving enough', async () => {

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

    });

});

