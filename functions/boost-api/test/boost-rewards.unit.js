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
    }
});

const testBoostId = uuid();
const testSavingTxId = uuid();
const testFloatId = 'some-float';
const testBonusPoolId = 'some-pool';

describe('*** UNIT TEST BOOST REDEMPTION OPERATIONS', () => {

    beforeEach(() => helper.resetStubs(lamdbaInvokeStub, publishStub));

    it('Handles random rewards', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();
        const testCalculatedAmount = 75000;

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

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(expectedAllocationResult) });

        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters: {
                rewardType: 'RANDOM',
                distribution: 'UNIFORM',
                realizedRewardModuloZeroTarget: 5000 // HUNDREDTH_CENT
            },
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
        expect(resultOfRedemption).to.deep.equal(expectedAllocationResult);

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

        const assembleAllocationInvocation = (recipientIds, allocationAmount, transactionType) => {
            const recipients = recipientIds.map((recipientId) => ({
                recipientId, amount: allocationAmount, recipientType: 'END_USER_ACCOUNT'
            }));

            return {
                instructions: [{
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
                }]
            };
        };

        const expectedPerPersonAmount = testContribPerUserAmount * testPercentForPool;
        const toBonusPoolPayload = assembleAllocationInvocation(testPooledAccountIds, -expectedPerPersonAmount, 'BOOST_POOL_FUNDING');
        const expectedTransferToBonusPoolInvocation = helper.wrapLambdaInvoc('float_transfer', false, toBonusPoolPayload);

        const fromBonusPoolPayload = assembleAllocationInvocation([testAccountId], testCalculatedAmount, 'BOOST_REDEMPTION');
        const expectedAllocationInvocation = helper.wrapLambdaInvoc('float_transfer', false, fromBonusPoolPayload);

        const expectedAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid()],
                accountTxIds: [uuid()]
            }
        };

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(expectedAllocationResult) });
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

        expect(resultOfRedemption).to.exist;
        expect(resultOfRedemption).to.deep.equal(expectedAllocationResult);

        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedAllocationInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedTransferToBonusPoolInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        
        expect(publishStub).to.have.been.calledOnce;
        expect(publishMultiStub).to.have.been.calledOnce;
    });

});
