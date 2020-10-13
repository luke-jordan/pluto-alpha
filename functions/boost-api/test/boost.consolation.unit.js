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

const lambdaInvokeStub = sinon.stub();

const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
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
    
    const testBoostAmountWCurr = 100;
    const testBoostAmountHCent = testBoostAmountWCurr * (100 * 100);

    const createAllocationPayload = (recipients, unit = 'WHOLE_CURRENCY', referenceKey = 'boostAmount') => ({ instructions: [{
        identifier: testBoostId,
        floatId: testFloatId,
        fromId: testBonusPoolId,
        fromType: 'BONUS_POOL',
        transactionType: 'BOOST_REDEMPTION',
        relatedEntityType: 'BOOST_REDEMPTION',
        currency: 'USD',
        unit,
        settlementStatus: 'SETTLED',
        allocType: 'BOOST_REDEMPTION',
        allocState: 'SETTLED',
        recipients,
        referenceAmounts: {
            [referenceKey]: recipients[0].amount,
            amountFromBonus: recipients[0].amount
        } 
    }]});

    const mockAllocResult = (numTx) => ({
        [testBoostId]: { result: 'SUCCESS', floatTxIds: Array(numTx).fill(uuid()), accountTxIds: Array(numTx).fill(uuid()) }
    });

    beforeEach(() => {
        helper.resetStubs(lambdaInvokeStub, publishMultiStub, publishStub, momentStub);
        momentStub.returns(moment());
    });

    it('Awards consolation prize to all participating users who did not win', async () => {
        const rewardParameters = {
            consolationPrize: {
                type: 'FIXED',
                recipients: { basis: 'ALL' },
                amount: { amount: 100, unit: 'WHOLE_CENT', currency: 'USD' }
            }
        };

        const expectedAmountInHCent = 100 * 100; // i.e., in default currency

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testBoostAmountWCurr,
            boostUnit: 'WHOLE_CURRENCY',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'user-id-1', priorStatus: 'PENDING', newStatus: 'REDEEMED' },
                'account-id-2': { userId: 'user-id-2', priorStatus: 'PENDING', newStatus: 'CONSOLED' },
                'account-id-3': { userId: 'user-id-3', priorStatus: 'PENDING', newStatus: 'CONSOLED' },
                'account-id-4': { userId: 'user-id-4', priorStatus: 'PENDING', newStatus: 'CONSOLED' }
            }
        };

        const winnerTransfer = createAllocationPayload([
            { recipientId: 'account-id-1', amount: testBoostAmountWCurr, recipientType: 'END_USER_ACCOUNT' }
        ]);

        const recipient = (accountId) => ({ recipientId: accountId, amount: expectedAmountInHCent, recipientType: 'END_USER_ACCOUNT' });
        const consolationRecipients = [recipient('account-id-2'), recipient('account-id-3'), recipient('account-id-4')];
        const consolationTransfer = createAllocationPayload(consolationRecipients, 'HUNDREDTH_CENT', 'consolationAmount');

        const expectedBoostAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, winnerTransfer);
        const expectedConsolationAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, consolationTransfer);

        const mockWinnerAllocationResult = mockAllocResult(1);
        const mockConsolationAllocResult = mockAllocResult(3);

        lambdaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse(mockWinnerAllocationResult)});
        lambdaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockConsolationAllocResult) });

        publishStub.resolves({ result: 'SUCCESS' });

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { }
        };

        const resultOfConsolation = await handler.redeemOrRevokeBoosts(mockEvent);
        expect(resultOfConsolation).to.exist;

        const mergedAccountTxIds = [...mockWinnerAllocationResult[testBoostId].accountTxIds, ...mockConsolationAllocResult[testBoostId].accountTxIds];
        const mergedFloatTxIds = [...mockWinnerAllocationResult[testBoostId].floatTxIds, ...mockConsolationAllocResult[testBoostId].floatTxIds];

        const expectedTotalAmount = testBoostAmountHCent + (3 * expectedAmountInHCent);

        const expectedResult = {
            [testBoostId]: {
                accountTxIds: mergedAccountTxIds,
                floatTxIds: mergedFloatTxIds,
                boostAmount: testBoostAmountHCent,
                consolationAmount: expectedAmountInHCent, 
                amountFromBonus: expectedTotalAmount,
                unit: 'HUNDREDTH_CENT'
            }
        };

        expect(resultOfConsolation).to.deep.equal(expectedResult);

        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedBoostAllocInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedConsolationAllocInvocation);
        expect(lambdaInvokeStub).to.have.been.calledTwice;

        expect(publishStub.callCount).to.equal(4);
        expect(publishStub).to.have.been.calledWith('user-id-1', 'BOOST_REDEEMED');
        expect(publishStub).to.have.been.calledWith('user-id-2', 'BOOST_CONSOLED');
    });

    it('Awards random consolation prize to specified number of users', async () => {
        const rewardParameters = {
            consolationPrize: {
                amount: { amount: 200, unit: 'WHOLE_CENT', currency: 'USD' },
                recipients: { basis: 'ABSOLUTE', value: 2 },
                type: 'RANDOM'
            }
        };

        const mathRandomStub = sinon.stub(Math, 'random');
        mathRandomStub.returns(0.55);
        const randomConsolationAmount = 110 * 100;

        const winningRecipients = [
            { recipientId: 'account-id-3', amount: testBoostAmountHCent, recipientType: 'END_USER_ACCOUNT' }
        ];

        const consolationRecipients = [
            { recipientId: 'account-id-1', amount: randomConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
            { recipientId: 'account-id-2', amount: randomConsolationAmount, recipientType: 'END_USER_ACCOUNT' }
        ];

        const expectedBoostAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(winningRecipients, 'HUNDREDTH_CENT'));
        const consolationAllocation = createAllocationPayload(consolationRecipients, 'HUNDREDTH_CENT', 'consolationAmount');
        const expectedConsolationAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, consolationAllocation);

        const mockWinnerAllocationResult = mockAllocResult(1);
        const mockConsolationAllocResult = mockAllocResult(2);

        lambdaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse(mockWinnerAllocationResult)});
        lambdaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockConsolationAllocResult) });
        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testBoostAmountHCent,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            boostType: 'GAME',
            boostCategory: 'QUIZ',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'user-id-1', newStatus: 'CONSOLED' },
                'account-id-2': { userId: 'user-id-2', newStatus: 'CONSOLED' },
                'account-id-3': { userId: 'user-id-3', newStatus: 'REDEEMED' },
                'account-id-4': { userId: 'user-id-4', newStatus: 'EXPIRED' } // will not be awarded
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { }
        };

        const mockUpdateMoment = moment();
        momentStub.returns(mockUpdateMoment);

        const resultOfConsolation = await handler.redeemOrRevokeBoosts(mockEvent);
        expect(resultOfConsolation).to.exist;

        const mergedAccountTxIds = [...mockWinnerAllocationResult[testBoostId].accountTxIds, ...mockConsolationAllocResult[testBoostId].accountTxIds];
        const mergedFloatTxIds = [...mockWinnerAllocationResult[testBoostId].floatTxIds, ...mockConsolationAllocResult[testBoostId].floatTxIds];

        const expectedTotalAmount = testBoostAmountHCent + (2 * randomConsolationAmount);

        const expectedResult = {
            [testBoostId]: {
                accountTxIds: mergedAccountTxIds,
                floatTxIds: mergedFloatTxIds,
                boostAmount: testBoostAmountHCent,
                consolationAmount: randomConsolationAmount,
                amountFromBonus: expectedTotalAmount,
                unit: 'HUNDREDTH_CENT'
            }
        };

        expect(resultOfConsolation).to.deep.equal(expectedResult);

        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedBoostAllocInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedConsolationAllocInvocation);
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        
        expect(publishStub.callCount).to.equal(4);

        const expectedBoostContext = {
            accountId: 'account-id-2',
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'QUIZ',
            boostUpdateTimeMillis: mockUpdateMoment.valueOf(),
            boostAmount: `${testBoostAmountHCent}::HUNDREDTH_CENT::USD`,
            consolationAmount: `${randomConsolationAmount}::HUNDREDTH_CENT::USD`,
            amountFromBonus: `${expectedTotalAmount}::HUNDREDTH_CENT::USD`,
            transferResults: expectedResult[testBoostId],
            triggeringEventContext: undefined
        };

        expect(publishStub).to.have.been.calledWith('user-id-2', 'BOOST_CONSOLED', { context: expectedBoostContext });
        
        mathRandomStub.restore();
    });

    // note : the status flip will actually have to happen upstream
    it('Awards consolation prize to a specified proportion of participating users', async () => {
        const rewardParameters = {
            consolationPrize: {
                amount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
                recipients: { basis: 'PROPORTION', value: 0.25 },
                type: 'FIXED'
            }
        };

        const boostRecipients = [
            { recipientId: 'account-id-4', amount: testBoostAmountWCurr, recipientType: 'END_USER_ACCOUNT' }
        ];

        const consolationRecipients = [
            { recipientId: 'account-id-1', amount: 10000, recipientType: 'END_USER_ACCOUNT' }
        ];

        const expectedBoostAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, createAllocationPayload(boostRecipients));
        
        const expectedConsoleInvoke = createAllocationPayload(consolationRecipients, 'HUNDREDTH_CENT', 'consolationAmount');
        const expectedConsolationAllocInvocation = helper.wrapLambdaInvoc('float_transfer', false, expectedConsoleInvoke);

        const mockAllocationResult = mockAllocResult(1);
        const mockConsoleResult = mockAllocResult(1);

        lambdaInvokeStub.onFirstCall().returns({ promise: () => helper.mockLambdaResponse(mockAllocationResult)});
        lambdaInvokeStub.onSecondCall().returns({ promise: () => helper.mockLambdaResponse(mockConsoleResult)});

        publishStub.resolves({ result: 'SUCCESS' });

        const mockBoost = {
            boostId: testBoostId,
            boostAmount: testBoostAmountWCurr,
            boostUnit: 'WHOLE_CURRENCY',
            boostCurrency: 'USD',
            fromFloatId: testFloatId,
            fromBonusPoolId: testBonusPoolId,
            rewardParameters
        };

        const mockAccountMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'user-id-1', newStatus: 'CONSOLED' },
                'account-id-2': { userId: 'user-id-2', newStatus: 'EXPIRED' },
                'account-id-3': { userId: 'user-id-3', newStatus: 'EXPIRED' },
                'account-id-4': { userId: 'user-id-4', newStatus: 'REDEEMED' }
            }
        };

        const mockEvent = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: mockAccountMap, 
            event: { }
        };

        const resultOfConsolation = await handler.redeemOrRevokeBoosts(mockEvent);
        expect(resultOfConsolation).to.exist;

        const mergedAccountTxIds = [...mockAllocationResult[testBoostId].accountTxIds, ...mockConsoleResult[testBoostId].accountTxIds];
        const mergedFloatTxIds = [...mockAllocationResult[testBoostId].floatTxIds, ...mockConsoleResult[testBoostId].floatTxIds];

        const expectedAmount = testBoostAmountHCent + 10000; // plus $1 in Hcents

        const expectedResult = {
            [testBoostId]: {
                accountTxIds: mergedAccountTxIds,
                floatTxIds: mergedFloatTxIds,
                boostAmount: testBoostAmountHCent,
                consolationAmount: 10000, 
                amountFromBonus: expectedAmount,
                unit: 'HUNDREDTH_CENT'
            }
        };
        expect(resultOfConsolation).to.deep.equal(expectedResult);

        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedBoostAllocInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedConsolationAllocInvocation);
        expect(lambdaInvokeStub).to.have.been.calledTwice;

        expect(publishStub.callCount).to.equal(4);
    });

});
