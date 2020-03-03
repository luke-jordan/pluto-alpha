'use strict';

// const logger = require('debug')('jupiter:pending:test');
// const config = require('config');

const moment = require('moment');
const uuid = require('uuid');

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const checkPendingSaveStub = sinon.stub();

const publishEventStub = sinon.stub();

const listPendingStub = sinon.stub();
const fetchAccountForUserStub = sinon.stub();

const fetchTransactionStub = sinon.stub();
const updateTxSettlementStatusStub = sinon.stub();
const fetchInfoForBankRefStub = sinon.stub();
const addPaymentInfoRdsStub = sinon.stub();
const fetchLogsStub = sinon.stub();
const getAccountBalanceStub = sinon.stub();

const getPaymentUrlStub = sinon.stub();

const getFloatVarsStub = sinon.stub();

const momentStub = sinon.stub();

const proxyquire = require('proxyquire');

const handler = proxyquire('../pending-handler', {
    './saving-handler': {
        'checkPendingPayment': checkPendingSaveStub,
        '@noCallThru': true
    },
    './payment-link': {
        'getPaymentLink': getPaymentUrlStub,
        '@noCallThru': true
    },
    './persistence/rds': {
        'fetchTransaction': fetchTransactionStub,
        'updateTxSettlementStatus': updateTxSettlementStatusStub,
        'fetchLogsForTransaction': fetchLogsStub,
        'findAccountsForUser': fetchAccountForUserStub,
        'fetchPendingTransactions': listPendingStub,
        'fetchInfoForBankRef': fetchInfoForBankRefStub,
        'addPaymentInfoToTx': addPaymentInfoRdsStub,
        'sumAccountBalance': getAccountBalanceStub,
        '@noCallThru': true
    },
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': getFloatVarsStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishEventStub,
        '@noCallThru': true
    },
    'moment': momentStub
});

const mockUserId = uuid();

const wrapParamsWithPath = (params, path, systemWideUserId = mockUserId) => ({
    requestContext: {
        authorizer: {
            systemWideUserId
        }
    },
    httpMethod: 'POST',
    pathParameters: {
        proxy: path
    },
    body: JSON.stringify(params)
});

describe('*** Unit test simple functions', () => {

    beforeEach(() => helper.resetStubs(fetchAccountForUserStub, listPendingStub, fetchTransactionStub, getFloatVarsStub));
    
    it('Handles listing pending transactions', async () => {
        fetchAccountForUserStub.withArgs(mockUserId).resolves(['some-account']);
        listPendingStub.withArgs('some-account').resolves([]);
        const listResult = await handler.handlePendingTxEvent(wrapParamsWithPath({}, 'list'));
        expect(listResult).to.deep.equal({
            statusCode: 200,
            body: JSON.stringify({
                pending: []
            })
        });
    });

    it('Returns details on a pending transaction, manual EFT', async () => {
        const mockTransactionId = uuid();
        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId }, 'describe');
        
        const mockTransaction = { transactionId: mockTransactionId, paymentProvider: 'MANUAL_EFT', clientId: 'some-client', floatId: 'some-float' };
        fetchTransactionStub.resolves(mockTransaction);
        const mockBankDetails = { bankName: 'Capitec', beneficiaryName: 'Jupiter Stokvel' };
        getFloatVarsStub.resolves({ bankDetails: mockBankDetails });

        const resultOfRequest = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfRequest);
        expect(resultBody).to.deep.equal({ ...mockTransaction, bankDetails: mockBankDetails });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(getFloatVarsStub).to.have.been.calledOnceWithExactly('some-client', 'some-float');
        helper.expectNoCalls(fetchInfoForBankRefStub, getPaymentUrlStub, addPaymentInfoRdsStub); // at least
    });

    it('Returns details on a pending transaction, instant EFT', async () => {
        const mockTransactionId = uuid();
        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId }, 'describe');
        
        const mockTransaction = { transactionId: mockTransactionId, paymentProvider: 'OZOW', tags: ['linkhere'] };
        fetchTransactionStub.resolves(mockTransaction);

        const resultOfRequest = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfRequest);
        expect(resultBody).to.deep.equal(mockTransaction);

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        helper.expectNoCalls(fetchInfoForBankRefStub, getPaymentUrlStub, addPaymentInfoRdsStub, getFloatVarsStub); // at least
    });

    it('Also gives error on unknown operation', async () => {
        const mockEvent = wrapParamsWithPath({ transactionId: 'bad-or-dodgy' }, 'dothings');
        const badResult = await handler.handlePendingTxEvent(mockEvent);
        expect(badResult).to.deep.equal({ statusCode: 400, body: JSON.stringify({ error: 'UNKNOWN_OPERATION' })});
    });

});

describe('*** Unit test switching payment method', () => {
   
    const mockTransactionId = uuid();
    const mockAccountId = uuid();

    beforeEach(() => helper.resetStubs(fetchTransactionStub, fetchInfoForBankRefStub, getPaymentUrlStub, addPaymentInfoRdsStub, getFloatVarsStub));
    
    it('Handles switching from manual EFT to instant EFT, no prior instant EFT info', async () => {
        const mockAmountDict = { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'ZAR' };
        const mockTransaction = { transactionId: mockTransactionId, accountId: mockAccountId, transactionType: 'USER_SAVING_EVENT', paymentProvider: 'MANUAL_EFT', humanReference: 'JSAVE101', ...mockAmountDict };
        const mockInfo = { humanRef: 'JSAVE', count: 100};
        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'OZOW' }, 'update');

        fetchTransactionStub.resolves(mockTransaction);
        fetchInfoForBankRefStub.resolves(mockInfo);
        getPaymentUrlStub.resolves({ paymentUrl: 'https://something', paymentRef: 'some-payment-id', bankRef: 'JSAVE101' });

        const result = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(result);
        expect(resultBody).to.have.property('paymentRedirectDetails');
        expect(resultBody.paymentRedirectDetails).to.deep.equal({ urlToCompletePayment: 'https://something' });
        expect(resultBody).to.have.property('humanReference', 'JSAVE101');
        expect(resultBody).to.have.property('transactionDetails');

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(fetchInfoForBankRefStub).to.have.been.calledOnceWithExactly(mockAccountId);

        const expectedPaymentParams = { transactionId: mockTransactionId, accountInfo: { bankRefStem: 'JSAVE', priorSaveCount: 100 }, amountDict: mockAmountDict };
        expect(getPaymentUrlStub).to.have.been.calledOnceWithExactly(expectedPaymentParams);
        
        const expectedUpdateParams = { transactionId: mockTransactionId, paymentProvider: 'OZOW', paymentRef: 'some-payment-id', paymentUrl: 'https://something', bankRef: 'JSAVE101' };
        expect(addPaymentInfoRdsStub).to.have.been.calledOnceWithExactly(expectedUpdateParams);
    });

    it('Handles switching from manual EFT to instant EFT, prior instant EFT info exists', async () => {
        const mockTransaction = { 
            transactionId: mockTransactionId,
            transactionType: 'USER_SAVING_EVENT', 
            paymentProvider: 'MANUAL_EFT', 
            humanReference: 'JSAVE101',
            paymentReference: 'some-id',
            tags: [`PAYMENT_URL::https://somelink`]
        };

        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'OZOW' }, 'update');
        
        fetchTransactionStub.resolves(mockTransaction);

        const result = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(result);
        expect(resultBody).to.have.property('paymentRedirectDetails');
        expect(resultBody.paymentRedirectDetails).to.deep.equal({ urlToCompletePayment: 'https://somelink' });
        expect(resultBody).to.have.property('humanReference', 'JSAVE101');
        expect(resultBody).to.have.property('transactionDetails');
        
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(addPaymentInfoRdsStub).to.have.been.calledOnceWithExactly({ transactionId: mockTransactionId, paymentProvider: 'OZOW' });
        helper.expectNoCalls(fetchInfoForBankRefStub, getPaymentUrlStub);
    });

    it('Just returns payment URL if already instant', async () => {
        const mockTransaction = { 
            transactionType: 'USER_SAVING_EVENT', 
            paymentProvider: 'OZOW', 
            humanReference: 'JSAVE101',
            paymentReference: 'some-id',
            tags: [`PAYMENT_URL::https://somelink`]
        };

        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'OZOW' }, 'update');
        
        fetchTransactionStub.resolves(mockTransaction);

        const result = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(result);
        expect(resultBody).to.have.property('paymentRedirectDetails');
        expect(resultBody.paymentRedirectDetails).to.deep.equal({ urlToCompletePayment: 'https://somelink' });
        expect(resultBody).to.have.property('humanReference', 'JSAVE101');
        expect(resultBody).to.have.property('transactionDetails');
        
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        helper.expectNoCalls(fetchInfoForBankRefStub, getPaymentUrlStub, addPaymentInfoRdsStub);
    });

    it('Handles switching from instant EFT to manual EFT', async () => {
        const mockTransaction = { transactionId: mockTransactionId, transactionType: 'USER_SAVING_EVENT', clientId: 'test-client', floatId: 'test-float', paymentProvider: 'OZOW', humanReference: 'JSAVE101' };

        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'MANUAL_EFT'}, 'update');
        
        fetchTransactionStub.resolves(mockTransaction);
        const mockBankDetails = { bankName: 'Capitec', beneficiaryName: 'Jupiter Stokvel' };
        getFloatVarsStub.resolves({ bankDetails: mockBankDetails });
        
        const result = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(result);

        expect(resultBody).to.have.property('humanReference', 'JSAVE101');
        expect(resultBody).to.have.property('bankDetails');
        expect(resultBody.bankDetails).to.deep.equal({ bankName: 'Capitec', beneficiaryName: 'Jupiter Stokvel' });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(getFloatVarsStub).to.have.been.calledOnceWithExactly('test-client', 'test-float');
        expect(addPaymentInfoRdsStub).to.have.been.calledOnceWithExactly({ paymentProvider: 'MANUAL_EFT', transactionId: mockTransactionId }); // we do not erase this
        helper.expectNoCalls(fetchInfoForBankRefStub, getPaymentUrlStub);
    });

    it('Just returns with bank details again if manual payment already set', async () => {
        const mockTransaction = { transactionType: 'USER_SAVING_EVENT', clientId: 'test-client', floatId: 'test-float', paymentProvider: 'MANUAL_EFT', humanReference: 'JSAVE101' };
        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'MANUAL_EFT' }, 'update');
        
        fetchTransactionStub.resolves(mockTransaction);
        const mockBankDetails = { bankName: 'Capitec', beneficiaryName: 'Jupiter Stokvel' };
        getFloatVarsStub.resolves({ bankDetails: mockBankDetails });
        
        const result = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(result);
        expect(resultBody).to.have.property('humanReference', 'JSAVE101');
        expect(resultBody).to.have.property('bankDetails');
        expect(resultBody.bankDetails).to.deep.equal({ bankName: 'Capitec', beneficiaryName: 'Jupiter Stokvel' });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(getFloatVarsStub).to.have.been.calledOnceWithExactly('test-client', 'test-float');
        helper.expectNoCalls(addPaymentInfoRdsStub, fetchInfoForBankRefStub, getPaymentUrlStub);
    });

    it('Returns settled if transaction already done', async () => {
        const mockTransaction = { transactionType: 'USER_SAVING_EVENT', settlementStatus: 'SETTLED', humanReference: 'JSAVE101' };
        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'OZOW' }, 'update');
        fetchTransactionStub.resolves(mockTransaction);
        const result = await handler.handlePendingTxEvent(mockEvent);
        const resultBody = helper.standardOkayChecks(result);
        expect(resultBody).to.deep.equal({ settlementStatus: 'SETTLED' });
        helper.expectNoCalls(getFloatVarsStub, addPaymentInfoRdsStub, fetchInfoForBankRefStub, getPaymentUrlStub);
    });

    it('Returns bad request if transaction is not a save', async () => {
        const mockTransaction = { transactionType: 'WITHDRAWAL' };
        const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId, paymentMethod: 'MANUAL_EFT' }, 'update');
        fetchTransactionStub.resolves(mockTransaction);
        const result = await handler.handlePendingTxEvent(mockEvent);
        expect(result).to.deep.equal({ statusCode: 400, body: JSON.stringify({ message: 'Transaction is not a save' })});
        helper.expectNoCalls(getFloatVarsStub, addPaymentInfoRdsStub, fetchInfoForBankRefStub, getPaymentUrlStub);
    });

});

// todo : check that user ID matches account owner
describe('*** Unit test cancelling transaction', () => {

    const mockTransactionId = uuid();
    const mockAccountId = uuid();
    const mockRefTime = moment();
    const mockUpdatedTime = moment();

    const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId }, 'cancel');

    beforeEach(() => helper.resetStubs(publishEventStub, fetchTransactionStub, updateTxSettlementStatusStub));

    it('Handle user cancelling withdrawal', async () => {
        const mockTransaction = { transactionType: 'WITHDRAWAL', settlementStatus: 'PENDING', accountId: mockAccountId };

        fetchTransactionStub.resolves(mockTransaction);
        momentStub.returns(mockRefTime);
        updateTxSettlementStatusStub.resolves(mockUpdatedTime);

        const resultOfCancel = await handler.handlePendingTxEvent(mockEvent);

        const bodyOfEvent = helper.standardOkayChecks(resultOfCancel);
        expect(bodyOfEvent).to.deep.equal({ result: 'SUCCESS' });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        
        const txLogContext = { oldStatus: 'PENDING', newStatus: 'CANCELLED' };
        const expectedTxLog = { accountId: mockAccountId, referenceTime: mockRefTime, systemWideUserId: mockUserId, logContext: txLogContext };
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ 
            transactionId: mockTransactionId, 
            settlementStatus: 'CANCELLED', 
            logToInsert: expectedTxLog 
        });
        
        const userLogContext = { ...txLogContext, transactionId: mockTransactionId };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(mockUserId, 'WITHDRAWAL_EVENT_CANCELLED', { context: userLogContext });
    });

    it('Handle user cancelling save', async () => {
        const mockTransaction = { accountId: mockAccountId, transactionType: 'USER_SAVING_EVENT', settlementStatus: 'PENDING' };

        fetchTransactionStub.resolves(mockTransaction);
        momentStub.returns(mockRefTime);
        updateTxSettlementStatusStub.resolves(mockUpdatedTime);

        const resultOfCancel = await handler.handlePendingTxEvent(mockEvent);

        const bodyOfEvent = helper.standardOkayChecks(resultOfCancel);
        expect(bodyOfEvent).to.deep.equal({ result: 'SUCCESS' });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);

        const txLogContext = { oldStatus: 'PENDING', newStatus: 'CANCELLED' };
        const expectedTxLog = { accountId: mockAccountId, referenceTime: mockRefTime, systemWideUserId: mockUserId, logContext: txLogContext };
        expect(updateTxSettlementStatusStub).to.have.been.calledOnceWithExactly({ 
            transactionId: mockTransactionId, 
            settlementStatus: 'CANCELLED', 
            logToInsert: expectedTxLog 
        });

        const userLogContext = { ...txLogContext, transactionId: mockTransactionId };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(mockUserId, 'SAVING_EVENT_CANCELLED', { context: userLogContext });
    });

    it('Returns error if transaction already settled', async () => {
        const mockTransaction = { transactionId: mockTransactionId, transactionType: 'WITHDRAWAL', settlementStatus: 'SETTLED' };
        fetchTransactionStub.resolves(mockTransaction);

        const resultOfCancel = await handler.handlePendingTxEvent(mockEvent);
        
        expect(resultOfCancel).to.deep.equal({ statusCode: 400, body: JSON.stringify({ error: 'ALREADY_SETTLED' })});
        expect(updateTxSettlementStatusStub).to.not.have.been.called;
        expect(publishEventStub).to.not.have.been.called;
    });

    it('Handles error from non-existent transaction', async () => {
        fetchTransactionStub.resolves(null);
        const resultOfCancel = await handler.handlePendingTxEvent(mockEvent);
        expect(resultOfCancel).to.deep.equal({ statusCode: 400, body: JSON.stringify({ error: 'NO_TRANSACTION_FOUND' })});
        expect(updateTxSettlementStatusStub).to.not.have.been.called;
        expect(publishEventStub).to.not.have.been.called;
    });

    it('Returns error from strange operation', async () => {
        const badEvent = wrapParamsWithPath({ transactionId: mockTransactionId }, 'something');
        const result = await handler.handlePendingTxEvent(badEvent);
        expect(result).to.deep.equal({ statusCode: 400, body: JSON.stringify({ error: 'UNKNOWN_OPERATION' })});
    });

});

// todo : also check accountId-userId correspondence
describe('*** Unit test rechecking transaction', () => {

    const mockTransactionId = uuid();
    const mockAccountId = uuid();
    const mockSettledTime = moment().subtract(5, 'minutes');
    const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId }, 'check');

    beforeEach(() => helper.resetStubs(fetchTransactionStub, checkPendingSaveStub, getAccountBalanceStub));

    it('Handles rechecking a save, if still pending', async () => {
        fetchTransactionStub.resolves({ transactionId: mockTransactionId, transactionType: 'USER_SAVING_EVENT', settlementStatus: 'PENDING' });
        
        const pendingSaveResult = {
            statusCode: 200,
            body: JSON.stringify({
                result: 'PAYMENT_PENDING',
                bankDetails: 'some_details'
            })
        };
        checkPendingSaveStub.resolves(pendingSaveResult);

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        expect(resultOfCheck).to.deep.equal(pendingSaveResult);

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(checkPendingSaveStub).to.have.been.calledOnceWithExactly({ transactionId: mockTransactionId });
    });

    it('Handles rechecking a save, if settled already (e.g., by admin)', async () => {
        fetchTransactionStub.resolves({ 
            transactionType: 'USER_SAVING_EVENT', 
            accountId: mockAccountId, currency: 'ZAR', 
            settlementStatus: 'SETTLED', 
            settlementTime: mockSettledTime.format() 
        });
        
        fetchLogsStub.resolves([{ logId: 'some-log', logType: 'ADMIN_SETTLED_SAVE' }]);
        momentStub.withArgs(mockSettledTime.format()).returns(mockSettledTime);
        getAccountBalanceStub.resolves({ amount: 10000, unit: 100, currency: 'ZAR' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ 
            result: 'ADMIN_MARKED_PAID', 
            settlementTimeMillis: mockSettledTime.valueOf(),
            newBalance: { amount: 10000, unit: 100, currency: 'ZAR' }
        });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(getAccountBalanceStub).to.have.been.calledOnceWithExactly(mockAccountId, 'ZAR'); // send back now balance, _not_ at settlement
    });

    it('Handles rechecking a save, if settled already but no logs', async () => {
        fetchTransactionStub.resolves({ transactionId: mockTransactionId, transactionType: 'USER_SAVING_EVENT', settlementStatus: 'SETTLED', settlementTime: mockSettledTime.format() });
        fetchLogsStub.resolves([]);
        momentStub.withArgs(mockSettledTime.format()).returns(mockSettledTime);
        getAccountBalanceStub.resolves({ amount: 10000, unit: 100, currency: 'ZAR' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ 
            result: 'PAYMENT_SUCCEEDED', 
            settlementTimeMillis: mockSettledTime.valueOf(),
            newBalance: { amount: 10000, unit: 100, currency: 'ZAR' }
        });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
    });

    it('Handles rechecking a save, if settled by payment', async () => {
        fetchTransactionStub.resolves({ transactionId: mockTransactionId, transactionType: 'USER_SAVING_EVENT', settlementStatus: 'PENDING' });

        const pendingSaveResult = {
            statusCode: 200,
            body: JSON.stringify({
                result: 'PAYMENT_SUCCEEDED',
                newBalance: { amount: 1000, unit: 'WHOLE_CURRENCY' }
            })
        };
        checkPendingSaveStub.resolves(pendingSaveResult);
        getAccountBalanceStub.resolves({ amount: 10000, unit: 100, currency: 'ZAR' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        expect(resultOfCheck).to.deep.equal(pendingSaveResult);
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(checkPendingSaveStub).to.have.been.calledOnceWithExactly({ transactionId: mockTransactionId });
    });

    it('Handles rechecking a withdrawal, if settled', async () => {
        fetchTransactionStub.resolves({ transactionType: 'WITHDRAWAL', settlementStatus: 'SETTLED' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ result: 'WITHDRAWAL_SETTLED' });
        
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
    });

    it('Handles rechecking a withdrawal, if another status', async () => {
        fetchTransactionStub.resolves({ transactionType: 'WITHDRAWAL', settlementStatus: 'PENDING' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ result: 'WITHDRAWAL_PENDING' });

        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
    });

    it('Swallows errors on non-existent transaction', async () => {
        fetchTransactionStub.resolves(null);
        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        expect(resultOfCheck).to.deep.equal({ statusCode: 400, body: JSON.stringify({ error: 'NO_TRANSACTION_FOUND' })});
    });

    it('Returns error on bad transaction type', async () => {
        fetchTransactionStub.resolves({ transactionType: 'ACCRUAL' });
        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        expect(resultOfCheck).to.deep.equal({ statusCode: 400, body: JSON.stringify({ error: 'BAD_TRANSACTION_TYPE' })});
    });

});
