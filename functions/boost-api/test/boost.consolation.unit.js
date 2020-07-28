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

    it('Awards consolation prize to specified users', async () => {
        const testBoostAmount = 10000;
        const testConsolationAmount = 100;

        const rewardParameters = {
            rewardType: 'CONSOLATION',
            consolationAmount: { amount: 100, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            consolationAwards: { basis: 'ALL' }
        };

        const allocationPayload = { instructions: [{
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
                { recipientId: 'account-id-1', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
                { recipientId: 'account-id-2', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
                { recipientId: 'account-id-3', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' },
                { recipientId: 'account-id-4', amount: testConsolationAmount, recipientType: 'END_USER_ACCOUNT' }
            ],
            referenceAmounts: { boostAmount: testConsolationAmount, amountFromBonus: testBoostAmount } 
        }]};

        const expectedAllocationInvocation = helper.wrapLambdaInvoc('float_transfer', false, allocationPayload);

        const mockAllocationResult = {
            [testBoostId]: {
                result: 'SUCCESS',
                floatTxIds: [uuid(), uuid(), uuid(), uuid()],
                accountTxIds: [uuid(), uuid(), uuid(), uuid()]
            }
        };

        lamdbaInvokeStub.returns({ promise: () => helper.mockLambdaResponse(mockAllocationResult) });
        momentStub.returns(moment());
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
                ...mockAllocationResult[testBoostId], 
                boostAmount: testConsolationAmount, 
                amountFromBonus: testBoostAmount
            }
        };

        expect(resultOfConsolation).to.deep.equal(expectedResult);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectedAllocationInvocation);
        expect(publishStub.callCount).to.equal(4);
    });
});
