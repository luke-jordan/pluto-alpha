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

const momentStub = sinon.stub();

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
    'moment': momentStub,
    'publish-common': {
        'publishUserEvent': publishStub
    }
});

const testBoostId = uuid();
const testFloatId = 'some-float';
const testBonusPoolId = 'some-pool';

describe('*** UNIT TEST BOOST REDEMPTION OPERATIONS', () => {

    beforeEach(() => testHelper.resetStubs(lamdbaInvokeStub, publishStub));

    it('Redeem a simple boost, from user saving enough', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();
        const testAmount = 20 * 100 * 100;

        const mockMoment = moment();

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
                ],
                referenceAmounts: { boostAmount: testAmount, amountFromBonus: testAmount }
            }]
        });

        const mockTransferResult = {
            result: 'SUCCESS',
            floatTxIds: [uuid(), uuid()],
            accountTxIds: [uuid()]
        };

        const expectedAllocationResult = {
            [testBoostId]: mockTransferResult
        };

        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(expectedAllocationResult) });
        momentStub.returns(mockMoment);
        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostType: 'SIMPLE',
            boostCategory: 'SIMPLE_SAVE',
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
                [testAccountId]: { userId: testUserId, newStatus: 'REDEEMED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { accountId: testAccountId, eventType: 'SAVING_EVENT_COMPLETED', eventContext: 'PROVIDED_CONTEXT' }
        };

        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        const expectedResult = {
            [testBoostId]: {
                ...mockTransferResult,
                boostAmount: testAmount,
                amountFromBonus: testAmount,
                unit: 'HUNDREDTH_CENT'
            }
        };

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedAllocationInvocation);
        expect(publishStub).to.have.been.calledOnce;

        const expectedPublishOptions = {
            initiator: testUserId,
            context: {
                accountId: testAccountId,
                amountFromBonus: `${testAmount}::HUNDREDTH_CENT::USD`,
                boostAmount: `${testAmount}::HUNDREDTH_CENT::USD`,
                boostId: testBoostId,
                boostType: 'SIMPLE',
                boostCategory: 'SIMPLE_SAVE',
                boostUpdateTimeMillis: mockMoment.valueOf(),
                transferResults: { ...expectedAllocationResult[testBoostId], boostAmount: testAmount, amountFromBonus: testAmount, unit: 'HUNDREDTH_CENT' },
                triggeringEventContext: 'PROVIDED_CONTEXT'
            }
        };
        
        expect(publishStub).to.have.been.calledOnceWithExactly(testUserId, 'BOOST_REDEEMED', expectedPublishOptions);
    });

    it('Redeem a referral boost', async () => {
        const mockMoment = moment();

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
                ],
                referenceAmounts: { boostAmount: testAmount, amountFromBonus: testAmount }
            }]
        });

        const mockTransferResult = {
            result: 'SUCCESS',
            floatTxIds: [uuid(), uuid(), uuid()],
            accountTxIds: [uuid(), uuid()]
        };
        const expectedAllocationResult = {
            [testBoostId]: mockTransferResult
        };

        lamdbaInvokeStub.onFirstCall().returns({ promise: () => testHelper.mockLambdaResponse(expectedAllocationResult) });
        
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

        momentStub.returns(mockMoment);

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
                [testReferredAccountId]: { userId: testReferredUserId, newStatus: 'REDEEMED' },
                [testReferringAccountId]: { userId: testReferringUserId, newStatus: 'REDEEMED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { accountId: testReferredAccountId, eventType: 'SAVING_EVENT_COMPLETED' }
        };
        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        const expectedResult = {
            [testBoostId]: {
                ...mockTransferResult,
                boostAmount: testAmount,
                amountFromBonus: testAmount,
                unit: 'HUNDREDTH_CENT'
            }
        };

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledWith(expectedAllocationInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWith(triggerMessagesInvocation);
    });

    it('Handles revocation', async () => {
        const testUserId = uuid();
        
        const testAmount = 20 * 100 * 100;

        const mockInstruction = (userAccountId) => ({
            identifier: testBoostId,
            floatId: testFloatId,
            fromId: userAccountId,
            fromType: 'END_USER_ACCOUNT',
            transactionType: 'BOOST_REVOCATION',
            relatedEntityType: 'BOOST_REVOCATION',
            relatedEntityId: testBoostId,
            currency: 'USD',
            unit: 'HUNDREDTH_CENT',
            settlementStatus: 'SETTLED',
            allocType: 'BOOST_REVOCATION',
            allocState: 'SETTLED',
            recipients: [
                { recipientId: testBonusPoolId, amount: testAmount, recipientType: 'BONUS_POOL' }
            ],
            referenceAmounts: { boostAmount: testAmount, amountToBonus: testAmount * 2 }
        });

        const mockInstructions = [mockInstruction('referred-user'), mockInstruction('referring-user')];
        const expectedAllocationInvocation = testHelper.wrapLambdaInvoc('float_transfer', false, { instructions: mockInstructions });

        // assumes that the transfer handler will knit these together (unfortunate, but cleanest way _at present_)
        const mockTransferResult = {
            [testBoostId]: { result: 'SUCCESS', floatTxIds: [uuid(), uuid(), uuid(), uuid()], accountTxIds: [uuid(), uuid()] }
        };

        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockTransferResult) });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testAmount,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE',
            flags: ['REDEEM_ALL_AT_ONCE']
        };

        const mockAccountMap = {
            [testBoostId]: {
                'referred-user': { userId: testUserId, status: 'REDEEMED', newStatus: 'REVOKED' },
                'referring-user': { userId: 'other-user', status: 'REDEEMED', newStatus: 'REVOKED' }
            }
        };

        const mockEvent = { 
            revocationBoosts: [mockBoost],
            affectedAccountsDict: mockAccountMap, 
            event: { accountId: 'referred-user', eventType: 'ADMIN_SETTLED_WITHDRAWAL', eventContext: 'ADMIN_SETTLED_WITHDRAWAL' }
        };

        momentStub.returns(moment());
        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        const expectedResult = {
            [testBoostId]: {
                ...mockTransferResult[testBoostId],
                boostAmount: testAmount,
                amountToBonus: testAmount * 2,
                unit: 'HUNDREDTH_CENT'
            }
        };

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedResult);

        testHelper.testLambdaInvoke(lamdbaInvokeStub, expectedAllocationInvocation);

        // then we do a user log, on each side (tested via the expect call underneath)
        const publishOptions = {
            initiator: testUserId,
            context: {
                accountId: 'referred-user',
                amountToBonus: '400000::HUNDREDTH_CENT::USD',
                boostAmount: '-200000::HUNDREDTH_CENT::USD',
                boostId: testBoostId,
                boostType: 'REFERRAL',
                boostCategory: 'USER_CODE',
                boostUpdateTimeMillis: sinon.match.number,
                transferResults: { ...mockTransferResult[testBoostId], amountToBonus: 400000, boostAmount: 200000, unit: 'HUNDREDTH_CENT' },
                triggeringEventContext: 'ADMIN_SETTLED_WITHDRAWAL'
            }
        };
        publishStub.resolves({ result: 'SUCCESS' });
        
        expect(publishStub).to.have.been.calledTwice;
        expect(publishStub).to.have.been.calledWith(testUserId, 'BOOST_REVOKED', publishOptions);
    });

});
