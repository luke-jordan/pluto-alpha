'use strict';

const uuid = require('uuid/v4');
const moment = require('moment');

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
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
});

const testBoostId = uuid();
const testFloatId = 'some-float';
const testBonusPoolId = 'some-pool';

describe('*** UNIT TEST BOOST REDEMPTION OPERATIONS', () => {

    beforeEach(() => testHelper.resetStubs(lamdbaInvokeStub, publishStub));

    it('Redeem a referral boost', async () => {
        const testReferredAccountId = uuid();
        const testReferringAccountId = uuid();

        const testReferredUserId = uuid();
        const testReferringUserId = uuid();

        const testReferringMsgId = uuid();
        const testReferredMsgId = uuid();

        const testAmount = 10 * 100 * 100;

        // invoke the float allocation lambda
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            instructions: [{
                identifier: testBoostId,
                floatId: testFloatId,
                fromId: testBonusPoolId,
                fromType: 'BONUS_POOL',
                currency: 'USD',
                unit: 'HUNDREDTH_CENT',
                transactionType: 'BOOST_REDEMPTION',
                relatedEntityType: 'BOOST_REDEMPTION',
                settlementStatus: 'SETTLED',
                allocType: 'BOOST_REDEMPTION',
                allocState: 'SETTLED',
                recipients: [
                    { recipientId: testReferredAccountId, amount: testAmount, recipientType: 'END_USER_ACCOUNT' },
                    { recipientId: testReferringAccountId, amount: testAmount, recipientType: 'END_USER_ACCOUNT' }
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

        lamdbaInvokeStub.onFirstCall().returns({  promise: () => testHelper.mockLambdaResponse(expectedAllocationResult) });
        
        // then we get the message instructions for each of the users, example within instruction:
        // message: `Congratulations! By signing up using your friend's referral code, you have earned a R10 boost to your savings`,
        // message: 'Congratulations! Busani Ndlovu has signed up to Jupiter using your referral code, earning you a R10 boost to your savings',
        const triggerMessagesInvocation = testHelper.wrapLambdaInvoc('message_user_create_once', true, {
            instructions: [{
                instructionId: testReferringMsgId,
                destinationUserId: testReferringUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }, {
                instructionId: testReferredMsgId,
                destinationUserId: testReferredUserId,
                parameters: { boostAmount: '$10' },
                triggerBalanceFetch: true
            }]
        });

        // logger('Expected message invocation: ', triggerMessagesInvocation);
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => testHelper.mockLambdaResponse({ result: 'SUCCESS' }) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testReferredUserId,
            context: {
                boostId: testBoostId,
                boostUpdateTimeMillis: moment().valueOf(),
                transferResults: expectedAllocationResult[testBoostId],
                eventContext: 'SAVING_EVENT_COMPLETED'
            }
        };
        publishStub.withArgs(testReferredUserId, 'REFERRAL_REDEEMED', sinon.match(publishOptions)).resolves({ result: 'SUCCESS' });
        publishStub.withArgs(testReferringUserId, 'REFERRAL_REDEEMED', publishOptions).resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testAmount,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            messageInstructions: [
                { accountId: testReferringAccountId, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
                { accountId: testReferredAccountId, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
            ],
            flags: ['REDEEM_ALL_AT_ONCE']    
        };

        const mockAccountMap = {
            [testBoostId]: {
                [testReferredAccountId]: { userId: testReferredUserId, status: 'PENDING' },
                [testReferringAccountId]: { userId: testReferringUserId, status: 'PENDING' },
            }
        }

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { accountId: testReferredAccountId, eventType: 'SAVING_EVENT_COMPLETED' }
        };
        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedAllocationResult);

        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedAllocationInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(triggerMessagesInvocation);
    });

    it('Redeem a simple boost, from user saving enough', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();
        const testAmount = 20 * 100 * 100;

        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, {
            instructions: [{
                identifier: testBoostId,
                floatId: testFloatId,
                fromId: testBonusPoolId,
                fromType: 'BONUS_POOL',
                transactionType: 'BOOST_REDEMPTION',
                relatedEntityType: 'BOOST_REDEMPTION',
                currency: 'USD',
                unit: 'HUNDREDTH_CENT',
                settlementStatus: 'SETTLED',
                allocType: 'BOOST_REDEMPTION',
                allocState: 'SETTLED',
                recipients: [
                    { recipientId: testAccountId, amount: testAmount, recipientType: 'END_USER_ACCOUNT' }
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

        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(expectedAllocationResult) });

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testUserId,
            context: {
                accountId: testAccountId,
                boostAmount: '100000::HUNDREDTH_CENT::USD',
                boostId: testBoostId,
                boostType: 'SIMPLE',
                boostCategory: 'TIME_LIMITED',
                boostUpdateTimeMillis: moment().valueOf(),
                transferResults: expectedAllocationResult[testBoostId],
                triggeringEventContext: 'SAVING_EVENT_COMPLETED'
            }
        };
        publishStub.withArgs(testUserId, 'BOOST_REDEEMED', sinon.match(publishOptions)).resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testAmount,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            messageInstructions: [],
            flags: []    
        };

        const mockAccountMap = {
            [testBoostId]: {
                [testAccountId]: { userId: testUserId, status: 'OFFERED' },
            }
        }

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { accountId: testAccountId, eventType: 'SAVING_EVENT_COMPLETED' }
        };

        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedAllocationResult);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedAllocationInvocation);
    });

    it('Handles revocation', async () => {

    });

    // extreme corner case but possibly user does something that earns a boost, then flips to other
    it('Handles both', async () => {

    });

});

