'use strict';

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const fetchAccountTagStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const updateTransactionTagStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const mockPersistence = { 
    fetchAccountTagByPrefix: fetchAccountTagStub,
    fetchTransaction: fetchTransactionStub,
    updateTxTags: updateTransactionTagStub
};

const mockLambda = { invoke: lambdaInvokeStub };

const setMockLambdaResponse = (response) => {
    const mockPayload = { Payload: JSON.stringify(response) };
    lambdaInvokeStub.returns({ promise: () => mockPayload });
};

const wrapMockEvent = (mockEventBody) => ({ 
    eventBody: mockEventBody, 
    persistence: mockPersistence,
    lambda: mockLambda
});

const handler = require('../event/boost-redeemed-event-handler.js');

describe('*** UNIT TESTING EVENT HANDLER FOR BOOST REDEEMED ***', () => {

    beforeEach(() => helper.resetStubs(fetchAccountTagStub, lambdaInvokeStub, fetchTransactionStub, updateTransactionTagStub));

    const mockAmount = 10 * 100 * 100;
    const mockEventBody = {
        eventType: 'BOOST_REDEEMED',
        context: {
            accountId: 'account-1',
            boostAmount: `${mockAmount}::HUNDREDTH_CENT::ZAR`,
            transferResults: {
                result: 'SUCCESS',
                accountTxIds: ['transaction-1']
            }
        }
    };

    it('Test happy path', async () => {
        fetchAccountTagStub.resolves('TESTPERSON1');
        fetchTransactionStub.resolves({ accountId: 'account-1', tags: ['PAYMENT_URL'], amount: mockAmount, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        setMockLambdaResponse({ result: 'SUCCESS' }); // actually irrelevant, as long as doesn't throw error
        updateTransactionTagStub.resolves({ updatedTime: 'some-time' });

        await handler.handleBoostRedeemedEvent(wrapMockEvent(mockEventBody));

        expect(fetchAccountTagStub).to.have.been.calledOnceWithExactly('account-1', 'FINWORKS');
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly('transaction-1');
        
        const expectedTransactionDetails = {
            accountNumber: 'TESTPERSON1',
            amount: 10,
            unit: 'WHOLE_CURRENCY',
            currency: 'ZAR'
        };

        const expectedPayload = { operation: 'BOOST', transactionDetails: expectedTransactionDetails };
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly({
            FunctionName: 'balance_sheet_acc_update',
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify(expectedPayload)
        });

        const expectedTag = `FINWORKS_RECORDED::${mockAmount}::HUNDREDTH_CENT::ZAR`;
        expect(updateTransactionTagStub).to.have.been.calledOnceWithExactly('transaction-1', expectedTag);
    });

    it('Does not tag if error on transaction', async () => {
        fetchAccountTagStub.resolves('TESTPERSON1');
        fetchTransactionStub.resolves({ accountId: 'account-1', tags: ['PAYMENT_URL'], amount: mockAmount, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        setMockLambdaResponse({ result: 'ERROR' });

        await handler.handleBoostRedeemedEvent(wrapMockEvent(mockEventBody));

        expect(fetchAccountTagStub).to.have.been.calledOnceWithExactly('account-1', 'FINWORKS');
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly('transaction-1');
        
        const expectedTransactionDetails = {
            accountNumber: 'TESTPERSON1',
            amount: 10,
            unit: 'WHOLE_CURRENCY',
            currency: 'ZAR'
        };

        const expectedPayload = { operation: 'BOOST', transactionDetails: expectedTransactionDetails };
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly({
            FunctionName: 'balance_sheet_acc_update',
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify(expectedPayload)
        });

        expect(updateTransactionTagStub).to.not.have.been.called;
    });

    it('Does not handle if already tagged with this amount', async () => {
        const expectedTag = `FINWORKS_RECORDED::${mockAmount}::HUNDREDTH_CENT::ZAR`;
        
        fetchAccountTagStub.resolves('TESTPERSON1');
        fetchTransactionStub.resolves({ accountId: 'account-1', tags: [expectedTag], amount: mockAmount, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        await handler.handleBoostRedeemedEvent(wrapMockEvent(mockEventBody));

        expect(fetchAccountTagStub).to.have.been.calledOnceWithExactly('account-1', 'FINWORKS');
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly('transaction-1');

        expect(lambdaInvokeStub).to.not.have.been.called;
        expect(updateTransactionTagStub).to.not.have.been.called;
    });

    it('Throws error if tagged with different amount', async () => {
        const mockTag = `FINWORKS_RECORDED::${mockAmount / 2}::HUNDREDTH_CENT::ZAR`;
        
        fetchAccountTagStub.resolves('TESTPERSON1');
        fetchTransactionStub.resolves({ accountId: 'account-1', tags: [mockTag], amount: mockAmount, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        await expect(handler.handleBoostRedeemedEvent(wrapMockEvent(mockEventBody))).to.be.
            rejectedWith('Error! Mismatched transaction and prior balance sheet operation');

        expect(fetchAccountTagStub).to.have.been.calledOnceWithExactly('account-1', 'FINWORKS');
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly('transaction-1');

        expect(lambdaInvokeStub).to.not.have.been.called;
        expect(updateTransactionTagStub).to.not.have.been.called;
    });

    it('Throws error if account transaction is different to boost', async () => {
        fetchAccountTagStub.resolves('TESTPERSON1');
        fetchTransactionStub.resolves({ accountId: 'account-1', tags: [], amount: mockAmount / 2, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        await expect(handler.handleBoostRedeemedEvent(wrapMockEvent(mockEventBody))).to.be.
            rejectedWith('Error! Mismatch between transaction as persisted and amount on boost redemption');

        expect(fetchAccountTagStub).to.have.been.calledOnceWithExactly('account-1', 'FINWORKS');
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly('transaction-1');

        expect(lambdaInvokeStub).to.not.have.been.called;
        expect(updateTransactionTagStub).to.not.have.been.called;
    });

    it('Throws error if no transaction ID or malformed', async () => {
        const malformedEventBody = JSON.parse(JSON.stringify(mockEventBody)); // need deep clone
        malformedEventBody.context.transferResults = {};

        await expect(handler.handleBoostRedeemedEvent(wrapMockEvent(malformedEventBody))).to.be.
            rejectedWith('Error! Malformed event context, no transaction ID');

        malformedEventBody.context.transferResults = { accountTxIds: [] };
        await expect(handler.handleBoostRedeemedEvent(wrapMockEvent(malformedEventBody))).to.be.
            rejectedWith('Error! Malformed event context, no transaction ID');        

        expect(fetchAccountTagStub).to.not.have.been.called;
        expect(fetchTransactionStub).to.not.have.been.called;
        expect(lambdaInvokeStub).to.not.have.been.called;
        expect(updateTransactionTagStub).to.not.have.been.called;            
    });

    it('Throws error if transaction does not match account', async () => {
        fetchAccountTagStub.resolves('TESTPERSON1');
        fetchTransactionStub.resolves({ accountId: 'account-2', tags: [], amount: mockAmount, unit: 'HUNDREDTH_CENT', currency: 'ZAR' });

        await expect(handler.handleBoostRedeemedEvent(wrapMockEvent(mockEventBody))).to.be.
            rejectedWith('Error! Transaction and account do not match');

        expect(fetchAccountTagStub).to.have.been.calledOnceWithExactly('account-1', 'FINWORKS');
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly('transaction-1');

        expect(lambdaInvokeStub).to.not.have.been.called;
        expect(updateTransactionTagStub).to.not.have.been.called;    
    });

});
