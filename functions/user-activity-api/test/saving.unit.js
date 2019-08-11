'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:save:test');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const moment = require('moment');
const testHelper = require('./test.helper');

const testAccountId = uuid();
const testUserId = uuid();
const testClientId = 'some_savings_co';
const testFloatId = 'usd_primary_float';
const testPaymentRef = 'some_ref_at_bank';

const testAuthContext = {
    authorizer: {
        systemWideUserId: testUserId
    }
};

const testSettlementTimeSeconds = 10;
const testTimeInitiated = moment().subtract(testSettlementTimeSeconds, 'seconds');
const testTimeSettled = moment();

const testNumberOfSaves = 5;
const testBaseAmount = 1000000;
const testAmounts = Array(testNumberOfSaves).fill().map(() => Math.floor(Math.random() * testBaseAmount));
const sumOfTestAmounts = testAmounts.reduce((cum, value) => cum + value, 0);
logger('Setting up, test amounts: ', testAmounts, ' with sum: ', sumOfTestAmounts);

const findMatchingTxStub = sinon.stub();
const findFloatStub = sinon.stub();
const addSavingsRdsStub = sinon.stub();
const updateSaveRdsStub = sinon.stub();

const momentStub = sinon.stub();

const handler = proxyquire('../saving-handler', {
    './persistence/rds': { 
        'findMatchingTransaction': findMatchingTxStub,
        'findClientAndFloatForAccount': findFloatStub, 
        'addSavingToTransactions': addSavingsRdsStub,
        'updateSaveTxToSettled': updateSaveRdsStub,
        '@noCallThru': true
    },
    'moment-timezone': momentStub
});

const resetStubHistory = () => {
    findMatchingTxStub.resetHistory();
    findFloatStub.resetHistory();
    addSavingsRdsStub.resetHistory();
    momentStub.reset();
    momentStub.callsFake(moment); // as with uuid in RDS, too much time being sunk into test framework's design flaws, so a work around here
};

describe('*** USER ACTIVITY *** UNIT TEST SAVING *** User saves, without reward, sync or async', () => {

    const testSaveSettlementBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        initiationTimeEpochMillis: testTimeInitiated.valueOf(),
        settlementTimeEpochMillis: testTimeSettled.valueOf(),
        settlementStatus: 'SETTLED',
        savedAmount: amount,
        savedCurrency: 'USD',
        savedUnit: 'HUNDREDTH_CENT',
        floatId: testFloatId,
        clientId: testClientId,
        paymentRef: testPaymentRef,
        paymentProvider: 'STRIPE'
    });

    const testSavePendingBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        initiationTimeEpochMillis: testTimeInitiated.valueOf(),
        settlementStatus: 'INITIATED',
        savedAmount: amount,
        savedCurrency: 'USD',
        savedUnit: 'HUNDREDTH_CENT'
    });

    const wrapTestEvent = (eventBody) => ({ body: JSON.stringify(eventBody), requestContext: testAuthContext });

    const wellFormedMinimalSettledRequestToRds = {
        accountId: testAccountId,
        initiationTime: testHelper.momentMatcher(testTimeInitiated),
        settlementTime: testHelper.momentMatcher(testTimeSettled),
        settlementStatus: 'SETTLED',
        savedAmount: sinon.match.number,
        savedCurrency: 'USD',
        savedUnit: 'HUNDREDTH_CENT',
        floatId: testFloatId,
        clientId: testClientId,
        paymentRef: testPaymentRef,
        paymentProvider: 'STRIPE'
    };

    const wellFormedMinimalPendingRequestToRds = {
        accountId: testAccountId,
        initiationTime: testHelper.momentMatcher(testTimeInitiated),
        settlementStatus: 'INITIATED',
        savedAmount: sinon.match.number,
        savedCurrency: 'USD',
        savedUnit: 'HUNDREDTH_CENT',
        clientId: testClientId,
        floatId: testFloatId
    };
    
    const responseToTxSettled = {
        transactionDetails: [{ accountTransactionId: uuid(), creationTime: moment().format() }, 
            { floatAdditionTransactionId: uuid(), creationTime: moment().format() },
            { floatAllocationTransactionId: uuid(), creationTime: moment().format() }],
        newBalance: { amount: sumOfTestAmounts, unit: 'HUNDREDTH_CENT' }
    };

    const responseToTxPending = {
        transactionDetails: [{ accountTransactionId: uuid(), persistedTimeEpochMillis: moment().format() }]
    };

    before(() => {
        findFloatStub.withArgs(testAccountId).resolves({ clientId: testClientId, floatId: testFloatId });
        addSavingsRdsStub.withArgs(sinon.match(wellFormedMinimalSettledRequestToRds)).resolves(responseToTxSettled);
        addSavingsRdsStub.withArgs(wellFormedMinimalPendingRequestToRds).resolves(responseToTxPending);
    });

    beforeEach(() => resetStubHistory());

    it('Fails gracefully, RDS failure', async () => {
        const badEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        badEvent.accountId = 'hello-blah-wrong';
        badEvent.clientId = testClientId;
        badEvent.floatId = testFloatId;

        const badRdsRequest = JSON.parse(JSON.stringify(wellFormedMinimalPendingRequestToRds));
        badRdsRequest.accountId = 'hello-blah-wrong';
        badRdsRequest.savedAmount = badEvent.savedAmount;
        badRdsRequest.initiationTime = testHelper.momentMatcher(testTimeInitiated);
        
        addSavingsRdsStub.withArgs(badRdsRequest).rejects(new Error('Error! Bad account ID'));
        
        const expectedError2 = await handler.initiatePendingSave({ body: JSON.stringify(badEvent), requestContext: testAuthContext });
        // testHelper.logNestedMatches(badRdsRequest, addSavingsRdsStub.getCall(0).args[0]);
        
        expect(expectedError2).to.exist;
        expect(expectedError2).to.have.property('statusCode', 500);
        expect(expectedError2).to.have.property('body', JSON.stringify('Error! Bad account ID')); // in case something puts a dict in error msg
    });

    it('Warmup handled gracefully', async () => {
        const expectedWarmupResponse = await handler.initiatePendingSave({});
        expect(expectedWarmupResponse).to.exist;
        expect(expectedWarmupResponse).to.have.property('statusCode', 400);
        expect(expectedWarmupResponse).to.have.property('body', 'Empty invocation');
    });

    it('Most common route, initiated payment, works as wrapper, happy path', async () => {
        const saveEventToWrapper = testSavePendingBase();
        Reflect.deleteProperty(saveEventToWrapper, 'settlementStatus');
        Reflect.deleteProperty(saveEventToWrapper, 'initiationTimeEpochMillis');
        momentStub.returns(testTimeInitiated);
        logger('Seeking: ', testTimeInitiated.valueOf());
        const apiGwMock = { body: JSON.stringify(saveEventToWrapper), requestContext: testAuthContext };
        const resultOfWrapperCall = await handler.initiatePendingSave(apiGwMock);
        logger('Received: ', resultOfWrapperCall);
        const saveBody = testHelper.standardOkayChecks(resultOfWrapperCall);
        expect(saveBody).to.deep.equal(responseToTxPending);
    });

    it('Wrapper fails if no auth context', async () => {
        const noAuthEvent = { body: JSON.stringify(testSavePendingBase()), requestContext: { }};
        const resultOfCallWithNoContext = await handler.initiatePendingSave(noAuthEvent);
        expect(resultOfCallWithNoContext).to.exist;
        expect(resultOfCallWithNoContext).to.have.property('statusCode', 403);
    });

    it('Saves, with payment at same time, and client and float explicit', async () => {
        const saveEventWellFormed = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        
        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEventWellFormed));
        
        expect(saveResult).to.exist;
        expect(saveResult).to.have.property('statusCode', 200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxSettled);
    });

    it('Saves, with payment at same time, but no float explicit', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEvent, 'floatId');
        Reflect.deleteProperty(saveEvent, 'clientId');
        
        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));
        
        expect(saveResult).to.have.property('statusCode', 200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxSettled);
        expect(findFloatStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalSettledRequestToRds);
        expect(findMatchingTxStub).to.have.not.been.called;
    });
        
    it('Stores pending, if no payment information', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        
        logger('Well formed request: ', wellFormedMinimalPendingRequestToRds);

        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxPending);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalPendingRequestToRds);
        expect(findFloatStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    it('Stores pending, if given client and float too', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        saveEvent.floatId = testFloatId;
        saveEvent.clientId = testClientId;

        logger('Well formed request: ', wellFormedMinimalPendingRequestToRds);

        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxPending);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalPendingRequestToRds);
        expect(findFloatStub).to.not.have.been.called;
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    it('Throws an error when no account information, currency, unit or amount provided', async () => {
        const saveEventNoAccountId = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAccountId, 'accountId');
        const saveEventNoAmount = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAmount, 'savedAmount');
        const saveEventNoCurrency = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoCurrency, 'savedCurrency');
        const saveEventNoUnit = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoUnit, 'savedUnit');

        const expectedNoAccountError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoAccountId));
        testHelper.checkErrorResultForMsg(expectedNoAccountError, 'Error! No account ID provided for the save');

        const expectedNoAmountError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoAmount));
        const expectedNoCurrencyError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoCurrency));
        const expectedNoUnitError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoUnit));

        testHelper.checkErrorResultForMsg(expectedNoAmountError, 'Error! No amount provided for the save');
        testHelper.checkErrorResultForMsg(expectedNoCurrencyError, 'Error! No currency specified for the saving event');
        testHelper.checkErrorResultForMsg(expectedNoUnitError, 'Error! No unit specified for the saving event');
    });

    /* 
    it('Throws an error when provided a misaligned client Id and floatId', async () => {

    });

    it('Throw an error if state is PENDING but includes settlement time', () => {

    });
     */
    
});

describe('*** UNIT TESTING PAYMENT UPDATE TO SETTLED ****', () => {

    const testPendingTxId = uuid();
    const testSettlementTime = moment();
    const testPaymentDetails = { paymentProvider: 'STRIPE', paymentRef: 'xyz123' };

    const responseToTxUpdated = {
        transactionDetails: [
            { accountTransactionId: testPendingTxId, updatedTime: moment().format() }, 
            { floatAdditionTransactionId: uuid(), creationTime: moment().format() },
            { floatAllocationTransactionId: uuid(), creationTime: moment().format() }
        ],
        newBalance: { amount: sumOfTestAmounts, unit: 'HUNDREDTH_CENT' }
    };

    beforeEach(() => testHelper.resetStubs(updateSaveRdsStub));

    it('Check for payment settles if payment has been successful', async () => {
        const expectedResult = JSON.parse(JSON.stringify(responseToTxUpdated));
        expectedResult.result = 'PAYMENT_SUCCEEDED';

        const dummyPaymentDetails = { paymentRef: sinon.match.string, paymentProvider: 'OZOW' };
        updateSaveRdsStub.withArgs(testPendingTxId, dummyPaymentDetails, testSettlementTime).resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const paymentCheckSuccessResult = await handler.checkPendingPayment({ queryStringParameters: { transactionId: testPendingTxId }});
        expect(paymentCheckSuccessResult).to.have.property('statusCode', 200);
        expect(paymentCheckSuccessResult).to.have.property('body');
        const resultOfCheck = JSON.parse(paymentCheckSuccessResult.body);
        expect(resultOfCheck).to.deep.equal(expectedResult);
    });

    it('Happy path, completes an update properly, no settlement time', async () => {
        updateSaveRdsStub.withArgs(testPendingTxId, testPaymentDetails, testSettlementTime).resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const updateTxResult = await handler.settle({ transactionId: testPendingTxId, paymentRef: 'xyz123', paymentProvider: 'STRIPE' });
        expect(updateTxResult).to.exist;
        expect(updateTxResult).to.have.property('statusCode', 200);
        expect(updateTxResult).to.have.property('body');
        const resultOfUpdate = JSON.parse(updateTxResult.body);
        expect(resultOfUpdate).to.deep.equal(responseToTxUpdated);
    });

    it('Handles validation errors properly', async () => {
        const expectNoTxError = await handler.settle({ paymentRef: 'xyz123', paymentProvider: 'STRIPE' });
        testHelper.checkErrorResultForMsg(expectNoTxError, 'Error! No transaction ID provided');
        const expectNoPaymentRefError = await handler.settle({ transactionId: testPendingTxId, paymentProvider: 'STRIPE' });
        testHelper.checkErrorResultForMsg(expectNoPaymentRefError, 'Error! No payment reference or provider');
        const expectNoPaymentProviderErr = await handler.settle({ transactionId: testPendingTxId, paymentRef: 'xyz123' });
        testHelper.checkErrorResultForMsg(expectNoPaymentProviderErr, 'Error! No payment reference or provider');
    });

    it('Wrapper inserts payment provider properly', async () => {
        updateSaveRdsStub.withArgs(testPendingTxId, testPaymentDetails, testSettlementTime).resolves(responseToTxUpdated);
        momentStub.returns(testSettlementTime);

        const testBody = { 
            transactionId: testPendingTxId,
            settlementTimeEpochMillis: testSettlementTime.valueOf(), 
            paymentRef: 'xyz123' 
        };

        const testRequest = {
            requestContext: { authorizer: { systemWideUserId: uuid() }},
            body: JSON.stringify(testBody)
        };

        const updateTxResult = await handler.settleInitiatedSave(testRequest);
        expect(updateTxResult).to.exist;
        expect(updateTxResult).to.have.property('statusCode', 200);
        expect(updateTxResult).to.have.property('body');
        const resultOfUpdate = JSON.parse(updateTxResult.body);
        expect(resultOfUpdate).to.deep.equal(responseToTxUpdated);
    });

    it('Wrapper handles warmup gracefully', async () => {
        const expectedWarmupResponse = await handler.settleInitiatedSave({});
        expect(expectedWarmupResponse).to.exist;
        expect(expectedWarmupResponse).to.have.property('statusCode', 400);
        expect(expectedWarmupResponse).to.have.property('body', 'Empty invocation');
    });

    it('Swallows context error gracefully', async () => {
        const updateErrorResult = await handler.settleInitiatedSave({ transactionId: testPendingTxId, paymentRef: 'xyz123' });
        logger('Looks like: ', updateErrorResult);
        expect(updateErrorResult).to.exist;
        expect(updateErrorResult).to.deep.equal({ statusCode: 500, body: JSON.stringify(`Cannot read property 'authorizer' of undefined`) });
    });

    it('Swallows RDS error gracefully', async () => {
        updateSaveRdsStub.withArgs(testPendingTxId, testPaymentDetails, testSettlementTime).rejects(new Error('Commit error!'));
        momentStub.returns(testSettlementTime);
        
        const updateTxResult = await handler.settle({ transactionId: testPendingTxId, paymentRef: 'xyz123', paymentProvider: 'STRIPE' });
        expect(updateTxResult).to.exist;
        expect(updateTxResult).to.have.property('statusCode', 500);
        expect(updateTxResult).to.have.property('body');
        const resultOfUpdate = JSON.parse(updateTxResult.body);
        expect(resultOfUpdate).to.deep.equal('Commit error!');
    });

    it('Rejects unauthorized requests properly', async () => {
        const unauthorizedResponse = await handler.settleInitiatedSave({ 
            body: JSON.stringify({ transactionId: testPendingTxId }), 
            requestContext: { }
        });

        expect(unauthorizedResponse).to.exist;
        expect(unauthorizedResponse).to.deep.equal({ statusCode: 403, message: 'User ID not found in context' });
    });

});
