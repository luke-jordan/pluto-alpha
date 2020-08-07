'use strict';

// const logger = require('debug')('jupiter:consolation:test');
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

describe('*** UNIT TEST BOOST CONSOLATION ***', () => {
    const testBoostId = uuid();
    
    const testFloatId = 'some-float';
    const testBonusPoolId = 'some-pool';
    
    const testBoostAmount = 10000;
    const testConsolationAmount = 100;

    const createAllocationPayload = (recipients) => ({ instructions: [{
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
        recipients,
        referenceAmounts: {
            boostAmount: recipients[0].amount,
            amountFromBonus: recipients[0].amount
        } 
    }]});

    beforeEach(() => {
        helper.resetStubs(lamdbaInvokeStub, publishMultiStub, publishStub, momentStub);
        momentStub.returns(moment());
    });

    it('Awards consolation prize to all participating users who did not win', async () => {
        const rewardParameters = {
            consolationPrize: {
                amount: { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                recipients: { basis: 'ALL' },
                type: 'FIXED'
            }
        };

        const boostRecipients = [
            { recipientId: 'account-id-1', amount: testBoostAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const consolationRecipients = [
            { recipientId: 'account-id-2', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
            { recipientId: 'account-id-3', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
            { recipientId: 'account-id-4', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const expectedBoostAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(boostRecipients));
        const expectedConsolationAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(consolationRecipients));

        const mockBoostAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid()],
                accountTxIds: [uuid()]
            }
        };

        const mockConsolationAllocResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid(), uuid()],
                accountTxIds: [uuid(), uuid(), uuid()]
            }
        };

        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse(mockBoostAllocationResult)});
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockConsolationAllocResult) });

        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testBoostAmount,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'user-id-1', status: 'REDEEMED' },
                'account-id-2': { userId: 'user-id-2', status: 'OFFERED' },
                'account-id-3': { userId: 'user-id-3', status: 'OFFERED' },
                'account-id-4': { userId: 'user-id-4', status: 'OFFERED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { }
        };

        const resultOfConsolation = await handler.redeemOrRevokeBoosts(mockEvent);
        expect(resultOfConsolation).to.exist;

        const expectedResult = {
            [testBoostId]: {
                ...mockBoostAllocationResult[testBoostId], 
                boostAmount: testBoostAmount, 
                amountFromBonus: testBoostAmount
            }
        };

        expect(resultOfConsolation).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedBoostAllocInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedConsolationAllocInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledTwice;

        expect(publishStub.callCount).to.equal(4);
    });

    it('Awards consolation prize to specified number of users', async () => {
        const rewardParameters = {
            consolationPrize: {
                amount: { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                recipients: { basis: 'ABSOLUTE', value: 2 },
                type: 'RANDOM'
            },
            distribution: 'UNIFORM',
            realizedRewardModuloZeroTarget: 10,
            minRewardAmountPerUser: { amount: '10', unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };

        const randomConsolationAmount = 60;

        const boostRecipients = [
            { recipientId: 'account-id-3', amount: testBoostAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const consolationRecipients = [
            { recipientId: 'account-id-1', amount: randomConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
            { recipientId: 'account-id-2', amount: randomConsolationAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const expectedBoostAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(boostRecipients));
        const expectedConsolationAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(consolationRecipients));

        const mockBoostAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid()],
                accountTxIds: [uuid()]
            }
        };

        const mockConsolationAllocResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid()],
                accountTxIds: [uuid(), uuid()]
            }
        };

        lamdbaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse(mockBoostAllocationResult)});
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockConsolationAllocResult) });
        publishStub.resolves({ result: 'SUCCESS' });

        const mathRandomStub = sinon.stub(Math, 'random');
        mathRandomStub.returns(0.55);

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testBoostAmount,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'user-id-1', status: 'OFFERED' },
                'account-id-2': { userId: 'user-id-2', status: 'OFFERED' },
                'account-id-3': { userId: 'user-id-3', status: 'REDEEMED' },
                'account-id-4': { userId: 'user-id-4', status: 'OFFERED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { }
        };

        const resultOfConsolation = await handler.redeemOrRevokeBoosts(mockEvent);
        expect(resultOfConsolation).to.exist;

        const expectedResult = {
            [testBoostId]: {
                ...mockBoostAllocationResult[testBoostId], 
                boostAmount: testBoostAmount, 
                amountFromBonus: testBoostAmount
            }
        };

        expect(resultOfConsolation).to.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedBoostAllocInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedConsolationAllocInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledTwice;
        expect(publishStub.callCount).to.equal(4);
        mathRandomStub.restore();
    });

    it('Awards consolation prize to a specified proportion of participating users', async () => {
        const rewardParameters = {
            consolationPrize: {
                amount: { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                recipients: { basis: 'PROPORTION', value: 0.25 },
                type: 'FIXED'
            }
        };

        const boostRecipients = [
            { recipientId: 'account-id-4', amount: testBoostAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const consolationRecipients = [
            { recipientId: 'account-id-1', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const expectedBoostAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(boostRecipients));
        const expectedConsolationAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(consolationRecipients));

        const mockAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid()],
                accountTxIds: [uuid()]
            }
        };

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(mockAllocationResult)});

        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testBoostAmount,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'user-id-1', status: 'OFFERED' },
                'account-id-2': { userId: 'user-id-2', status: 'OFFERED' },
                'account-id-3': { userId: 'user-id-3', status: 'OFFERED' },
                'account-id-4': { userId: 'user-id-4', status: 'REDEEMED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { }
        };

        const resultOfConsolation = await handler.redeemOrRevokeBoosts(mockEvent);
        expect(resultOfConsolation).to.exist;

        const expectedResult = {
            [testBoostId]: {
                ...mockAllocationResult[testBoostId], 
                boostAmount: testBoostAmount, 
                amountFromBonus: testBoostAmount
            }
        };
        expect(resultOfConsolation).to.deep.equal(expectedResult);

        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedBoostAllocInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(expectedConsolationAllocInvocation);
        expect(lamdbaInvokeStub).to.have.been.calledTwice;

        expect(publishStub.callCount).to.equal(4);
    });

});
