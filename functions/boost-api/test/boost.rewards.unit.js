'use strict';

// const logger = require('debug')('jupiter:reward:test');
const uuid = require('uuid/v4');
const moment = require('moment');

const helper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const publishStub = sinon.stub();
const publishMultiStub = sinon.stub();

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
    'publish-common': {
        'publishUserEvent': publishStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'moment': momentStub
});

const testBoostId = uuid();
const testSavingTxId = uuid();
const testFloatId = 'some-float';
const testBonusPoolId = 'some-pool';

describe('*** UNIT TEST BOOST REDEMPTION OPERATIONS', () => {

    beforeEach(() => helper.resetStubs(lamdbaInvokeStub, publishStub, publishMultiStub));

    it('Handles random rewards', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();
        const testCalculatedAmount = 70000;

        const testRewardParameters = {
            rewardType: 'RANDOM',
            distribution: 'UNIFORM',
            realizedRewardModuloZeroTarget: 5000, // HUNDREDTH_CENT (matches boostUnit),
            minBoostAmountPerUser: { amount: '1000', unit: 'HUNDREDTH_CENT', currency: 'USD'}
        };

        const expectedAllocationInvocation = helper.wrapLambdaInvoc('float_transfer', false, {
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
                    { recipientId: testAccountId, amount: testCalculatedAmount, recipientType: 'END_USER_ACCOUNT' }
                ],
                referenceAmounts: { amountFromBonus: testCalculatedAmount, boostAmount: testCalculatedAmount } 
            }]
        });

        const mockAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid()],
                accountTxIds: [uuid()]
            }
        };

        sinon.restore(); // restores Math.random() stubbed in another file. after and afterEach didn't cut it.
        const mathRandomStub = sinon.stub(Math, 'random');
        mathRandomStub.returns(0.55);

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(mockAllocationResult) });
        momentStub.returns(moment());
        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters: testRewardParameters,
            messageInstructions: [],
            flags: []    
        };

        const mockAccountMap = {
            [testBoostId]: {
                [testAccountId]: { userId: testUserId, status: 'OFFERED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { accountId: testAccountId, eventType: 'SAVING_EVENT_COMPLETED' }
        };

        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        expect(resultOfRedemption).to.exist;

        const expectedResult = { 
            [testBoostId]: {
                ...mockAllocationResult[testBoostId], 
                boostAmount: testCalculatedAmount, 
                amountFromBonus: testCalculatedAmount
            }
        };
        expect(resultOfRedemption).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedAllocationInvocation);
        expect(publishStub).to.have.been.calledOnce;
    });

    it('Handles pooled rewards', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();

        const testUserCount = 5;
        const testContribPerUserAmount = 25000;
        const testPercentForPool = 0.05;
        
        const testCalculatedAmount = testUserCount * testContribPerUserAmount * (0.06);
        const testBonusPoolAmount = testUserCount * testContribPerUserAmount * 0.01; // i.e. proportion from client/bonus
        
        const timeSaveCompleted = moment();
        
        const testRewardParams = {
            rewardType: 'POOLED',
            poolContributionPerUser: { amount: testContribPerUserAmount, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            clientFloatContribution: { type: 'PERCENT_OF_POOL', value: 0.01, requiredFriends: 3 },
            percentPoolAsReward: testPercentForPool
        };

        const testPooledAccountIds = [];
        while (testPooledAccountIds.length < testUserCount) {
            testPooledAccountIds.push(uuid());
        }

        const assembleAllocationInvocation = (recipientIds, allocationAmount, transactionType, referenceAmounts) => {
            const recipients = recipientIds.map((recipientId) => ({
                recipientId, amount: allocationAmount, recipientType: 'END_USER_ACCOUNT'
            }));

            const invokeBody = {
                identifier: testBoostId,
                floatId: testFloatId,
                fromId: testBonusPoolId,
                fromType: 'BONUS_POOL',
                transactionType,
                relatedEntityType: transactionType,
                currency: 'USD',
                unit: 'HUNDREDTH_CENT',
                settlementStatus: 'SETTLED',
                allocType: transactionType,
                allocState: 'SETTLED',
                recipients
            };

            if (referenceAmounts) {
                invokeBody.referenceAmounts = referenceAmounts;
            }

            return { instructions: [invokeBody] };
        };

        const expectedPerPersonAmount = testContribPerUserAmount * testPercentForPool;
        const toBonusPoolPayload = assembleAllocationInvocation(testPooledAccountIds, -expectedPerPersonAmount, 'BOOST_POOL_FUNDING');
        const expectedTransferToBonusPoolInvocation = helper.wrapLambdaInvoc('float_transfer', false, toBonusPoolPayload);

        const expectedRefAmounts = { amountFromBonus: testBonusPoolAmount, boostAmount: testCalculatedAmount };
        const fromBonusPoolPayload = assembleAllocationInvocation([testAccountId], testCalculatedAmount, 'BOOST_REDEMPTION', expectedRefAmounts);
        const expectedAllocationInvocation = helper.wrapLambdaInvoc('float_transfer', false, fromBonusPoolPayload);

        const mockAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid()],
                accountTxIds: [uuid()]
            }
        };

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(mockAllocationResult) });
        momentStub.returns(moment());
        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters: testRewardParams,
            messageInstructions: [],
            flags: []    
        };

        const mockAccountMap = {
            [testBoostId]: {
                [testAccountId]: { userId: testUserId, status: 'OFFERED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            pooledContributionMap: { [testBoostId]: testPooledAccountIds },
            event: {
                accountId: testAccountId,
                eventType: 'SAVING_EVENT_COMPLETED',
                timeInMillis: timeSaveCompleted.valueOf(),
                eventContext: {
                    transactionId: testSavingTxId,
                    savedAmount: '100000::HUNDREDTH_CENT::USD',
                    firstSave: true
                }
            }
        };

        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        const expectedResult = {
            [testBoostId]: {
                ...mockAllocationResult[testBoostId],
                amountFromBonus: testBonusPoolAmount,
                boostAmount: testCalculatedAmount
            }
        };

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        helper.testLambdaInvoke(lamdbaInvokeStub, expectedAllocationInvocation, 1);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedTransferToBonusPoolInvocation);
        
        expect(publishStub).to.have.been.calledOnce;
        expect(publishMultiStub).to.have.been.calledOnce;
    });

    it('Handles pooled rewards if only one person (so, zero amount)', async () => {
        const testUserId = uuid();

        const testContribPerUserAmount = 25000;
        const testPercentForPool = 0.05;
                
        const testRewardParams = {
            rewardType: 'POOLED',
            poolContributionPerUser: { amount: testContribPerUserAmount, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            percentPoolAsReward: testPercentForPool
        };

        const testPooledAccountIds = ['account-1'];
        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: 0, // because updated in primary
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            boostType: 'GAME',
            boostCategory: 'TAP_SCREEN',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters: testRewardParams,
            messageInstructions: [],
            flags: []    
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-1': { userId: testUserId, status: 'OFFERED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            pooledContributionMap: { [testBoostId]: testPooledAccountIds },
            event: { accountId: 'account-1' }
        };

        const mockUpdateTime = moment();
        momentStub.returns(mockUpdateTime);

        const resultOfRedemption = await handler.redeemOrRevokeBoosts(mockEvent);

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal({});

        expect(publishStub).to.not.have.been.called;

        expect(lamdbaInvokeStub).to.not.have.been.called;
        expect(publishMultiStub).to.not.have.been.called;
    });

});
