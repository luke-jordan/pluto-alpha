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

const fetchTransactionStub = sinon.stub();
const updateTxSettlementStatusStub = sinon.stub();
const fetchLogsStub = sinon.stub();

const momentStub = sinon.stub();

const proxyquire = require('proxyquire');

const handler = proxyquire('../pending-handler', {
    './saving-handler': {
        'checkPendingPayment': checkPendingSaveStub,
        '@noCallThru': true
    },
    './persistence/rds': {
        'fetchTransaction': fetchTransactionStub,
        'updateTxSettlementStatus': updateTxSettlementStatusStub,
        'fetchLogsForTransaction': fetchLogsStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishEventStub
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
    const mockSettledTime = moment().subtract(5, 'minutes');
    const mockEvent = wrapParamsWithPath({ transactionId: mockTransactionId }, 'check');

    beforeEach(() => helper.resetStubs(fetchTransactionStub, checkPendingSaveStub));

    it('Handles rechecking a save, if still pending', async () => {
        fetchTransactionStub.resolves({ transactionType: 'USER_SAVING_EVENT', settlementStatus: 'PENDING' });
        
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
        fetchTransactionStub.resolves({ transactionType: 'USER_SAVING_EVENT', settlementStatus: 'SETTLED', settlementTime: mockSettledTime.format() });
        fetchLogsStub.resolves([{ logId: 'some-log', logType: 'ADMIN_SETTLED_SAVE' }]);
        momentStub.withArgs(mockSettledTime.format()).returns(mockSettledTime);

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ result: 'ADMIN_MARKED_PAID', settlementTimeMillis: mockSettledTime.valueOf() });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
    });

    it('Handles rechecking a save, if settled already but no logs', async () => {
        fetchTransactionStub.resolves({ transactionType: 'USER_SAVING_EVENT', settlementStatus: 'SETTLED', settlementTime: mockSettledTime.format() });
        fetchLogsStub.resolves([]);
        momentStub.withArgs(mockSettledTime.format()).returns(mockSettledTime);

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ result: 'PAYMENT_SUCCEEDED', settlementTimeMillis: mockSettledTime.valueOf() });
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
    });

    it('Handles rechecking a save, if settled by payment', async () => {
        fetchTransactionStub.resolves({ transactionType: 'USER_SAVING_EVENT', settlementStatus: 'PENDING' });

        const pendingSaveResult = {
            statusCode: 200,
            body: JSON.stringify({
                result: 'PAYMENT_SUCCEEDED',
                newBalance: { amount: 1000, unit: 'WHOLE_CURRENCY' }
            })
        };
        checkPendingSaveStub.resolves(pendingSaveResult);

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        expect(resultOfCheck).to.deep.equal(pendingSaveResult);
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
        expect(checkPendingSaveStub).to.have.been.calledOnceWithExactly({ transactionId: mockTransactionId });
    });

    it('Handles rechecking a withdrawal, if settled', async () => {
        fetchTransactionStub.resolves({ transactionType: 'WITHDRAWAL', settlementStatus: 'SETTLED' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ result: 'SETTLED' });
        
        expect(fetchTransactionStub).to.have.been.calledOnceWithExactly(mockTransactionId);
    });

    it('Handles rechecking a withdrawal, if another status', async () => {
        fetchTransactionStub.resolves({ transactionType: 'WITHDRAWAL', settlementStatus: 'PENDING' });

        const resultOfCheck = await handler.handlePendingTxEvent(mockEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfCheck);
        expect(resultBody).to.deep.equal({ result: 'PENDING' });

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
