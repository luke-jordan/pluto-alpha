'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:save:test');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();
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
    authorizer: { systemWideUserId: testUserId }
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
const findFloatOrIdStub = sinon.stub();
const addSavingsRdsStub = sinon.stub();
const addPaymentInfoRdsStub = sinon.stub();
const updateSaveRdsStub = sinon.stub();
const fetchTransactionStub = sinon.stub();
const countSettledSavesStub = sinon.stub();

const fetchBankRefStub = sinon.stub();
const getPaymentUrlStub = sinon.stub();

const publishStub = sinon.stub();

const momentStub = sinon.stub();

const handler = proxyquire('../saving-handler', {
    './persistence/rds': { 
        'findMatchingTransaction': findMatchingTxStub,
        'getOwnerInfoForAccount': findFloatOrIdStub, 
        'addTransactionToAccount': addSavingsRdsStub,
        'countSettledSaves': countSettledSavesStub,
        'addPaymentInfoToTx': addPaymentInfoRdsStub,
        'fetchInfoForBankRef': fetchBankRefStub
    },
    './payment-link': {
        'getPaymentLink': getPaymentUrlStub,
        'warmUpPayment': sinon.stub() // storing/inspecting would add clutter for no robustness
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
    'moment-timezone': momentStub
});

const resetStubHistory = () => {
    findMatchingTxStub.resetHistory();
    findFloatOrIdStub.resetHistory();
    addSavingsRdsStub.resetHistory();
    addPaymentInfoRdsStub.reset();
    updateSaveRdsStub.reset();
    fetchTransactionStub.reset();
    countSettledSavesStub.reset();
    getPaymentUrlStub.reset();
    fetchBankRefStub.reset();
    publishStub.reset();
    momentStub.reset();
    momentStub.callsFake(moment); // as with uuid in RDS, too much time being sunk into test framework's design flaws, so a work around here
};

describe('*** USER ACTIVITY *** UNIT TEST SAVING *** User initiates a save event', () => {

    const testTransactionId = uuid();

    const wrapTestEvent = (eventBody) => ({ body: JSON.stringify(eventBody), requestContext: testAuthContext });

    const testSaveSettlementBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        initiationTimeEpochMillis: testTimeInitiated.valueOf(),
        settlementTimeEpochMillis: testTimeSettled.valueOf(),
        settlementStatus: 'SETTLED',
        amount: amount,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        floatId: testFloatId,
        clientId: testClientId,
        paymentRef: testPaymentRef,
        paymentProvider: 'STRIPE'
    });

    const testSavePendingBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        initiationTimeEpochMillis: testTimeInitiated.valueOf(),
        settlementStatus: 'INITIATED',
        amount: amount,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT'
    });

    const wellFormedMinimalPendingRequestToRds = {
        accountId: testAccountId,
        initiationTime: testHelper.momentMatcher(testTimeInitiated),
        settlementStatus: 'INITIATED',
        amount: sinon.match.number,
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        clientId: testClientId,
        floatId: testFloatId
    };

    const testBankRefInfo = { humanRef: 'JUPSAVER31', count: 10 };
    const expectedPaymentInfo = {
        transactionId: testTransactionId,
        accountInfo: { bankRefStem: 'JUPSAVER31', priorSaveCount: 10 },
        amountDict: { amount: testAmounts[0], currency: 'USD', unit: 'HUNDREDTH_CENT' }
    };

    const expectedPaymentParams = {
        paymentUrl: 'https://pay.me/1234',
        paymentRef: testPaymentRef,
        paymentProvider: 'PROVIDER',
        bankRef: 'JUPSAVER31-00001'
    };

    const responseToTxPending = {
        transactionDetails: [{ accountTransactionId: testTransactionId, persistedTimeEpochMillis: moment().format() }]
    };

    const expectedResponseBody = {
        paymentRedirectDetails: {
            urlToCompletePayment: expectedPaymentParams.paymentUrl
        },
        humanReference: expectedPaymentParams.bankRef,
        transactionDetails: responseToTxPending.transactionDetails
    };

    before(() => {
        findFloatOrIdStub.withArgs(testAccountId).resolves({ clientId: testClientId, floatId: testFloatId });
        addSavingsRdsStub.withArgs(wellFormedMinimalPendingRequestToRds).resolves(responseToTxPending);
    });

    beforeEach(() => resetStubHistory());

    it('Most common route, initiated payment, works as wrapper, happy path', async () => {
        const saveEventToWrapper = testSavePendingBase();
        Reflect.deleteProperty(saveEventToWrapper, 'settlementStatus');
        Reflect.deleteProperty(saveEventToWrapper, 'initiationTimeEpochMillis');
        momentStub.returns(testTimeInitiated);

        fetchBankRefStub.resolves(testBankRefInfo);
        getPaymentUrlStub.resolves(expectedPaymentParams);
        
        const apiGwMock = { body: JSON.stringify(saveEventToWrapper), requestContext: testAuthContext };
        const resultOfWrapperCall = await handler.initiatePendingSave(apiGwMock);
        logger('Received: ', resultOfWrapperCall);

        const saveBody = testHelper.standardOkayChecks(resultOfWrapperCall);
        expect(saveBody).to.deep.equal(expectedResponseBody);

        expect(fetchBankRefStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(getPaymentUrlStub).to.have.been.calledOnceWithExactly(expectedPaymentInfo);
        expect(addPaymentInfoRdsStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, ...expectedPaymentParams });
    });

    it('Fails gracefully, RDS failure', async () => {
        const badEvent = { ...testSavePendingBase() };
        badEvent.accountId = 'hello-blah-wrong';
        badEvent.clientId = testClientId;
        badEvent.floatId = testFloatId;

        const badRdsRequest = { ...wellFormedMinimalPendingRequestToRds };
        badRdsRequest.accountId = 'hello-blah-wrong';
        badRdsRequest.amount = badEvent.amount;
        badRdsRequest.initiationTime = testHelper.momentMatcher(testTimeInitiated);
        
        addSavingsRdsStub.withArgs(badRdsRequest).rejects(new Error('Error! Bad account ID'));
        
        const expectedError2 = await handler.initiatePendingSave({ body: JSON.stringify(badEvent), requestContext: testAuthContext });
        
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

    it('Handles test request, configures request to third party sandbox', async () => {
        const minimalPendingRequestToRds = {
            accountId: testAccountId,
            initiationTime: testHelper.momentMatcher(testTimeInitiated),
            settlementStatus: 'INITIATED',
            amount: sinon.match.number,
            currency: 'USD',
            unit: 'HUNDREDTH_CENT',
            dummy: 'ON',
            clientId: testClientId,
            floatId: testFloatId
        };

        const expectedPaymentInfoTest = {
            transactionId: testTransactionId,
            accountInfo: { bankRefStem: 'JUPSAVER31', priorSaveCount: 10 },
            amountDict: { amount: testAmounts[0], currency: 'USD', unit: 'HUNDREDTH_CENT' }
        };

        const saveEventToWrapper = testSavePendingBase();
        Reflect.deleteProperty(saveEventToWrapper, 'settlementStatus');
        Reflect.deleteProperty(saveEventToWrapper, 'initiationTimeEpochMillis');
        saveEventToWrapper.dummy = 'ON';
        momentStub.returns(testTimeInitiated);

        fetchBankRefStub.resolves(testBankRefInfo);
        getPaymentUrlStub.resolves(expectedPaymentParams);
        addSavingsRdsStub.withArgs(minimalPendingRequestToRds).resolves(responseToTxPending);
        
        const apiGwMock = { body: JSON.stringify(saveEventToWrapper), requestContext: testAuthContext };
        const resultOfWrapperCall = await handler.initiatePendingSave(apiGwMock);
        logger('Received: ', resultOfWrapperCall);
        const saveBody = testHelper.standardOkayChecks(resultOfWrapperCall);
        expect(saveBody).to.deep.equal(responseToTxPending);

        expect(fetchBankRefStub).to.have.been.calledWithExactly(testAccountId);
        expect(getPaymentUrlStub).to.have.been.calledOnceWithExactly(expectedPaymentInfoTest);
        expect(addPaymentInfoRdsStub).to.have.been.calledOnceWithExactly({ transactionId: testTransactionId, ...expectedPaymentParams });
    });

    it('Wrapper fails if no auth context', async () => {
        const noAuthEvent = { body: JSON.stringify(testSavePendingBase()), requestContext: { }};
        const resultOfCallWithNoContext = await handler.initiatePendingSave(noAuthEvent);
        expect(resultOfCallWithNoContext).to.exist;
        expect(resultOfCallWithNoContext).to.have.property('statusCode', 403);
    });
        
    it('Stores pending, if no payment information', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        
        logger('Well formed request: ', wellFormedMinimalPendingRequestToRds);
        fetchBankRefStub.resolves(testBankRefInfo);
        getPaymentUrlStub.resolves(expectedPaymentParams);

        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxPending);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalPendingRequestToRds);
        expect(findFloatOrIdStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    it('Stores pending, if given client and float too', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSavePendingBase()));
        saveEvent.floatId = testFloatId;
        saveEvent.clientId = testClientId;

        logger('Well formed request: ', wellFormedMinimalPendingRequestToRds);
        fetchBankRefStub.resolves(testBankRefInfo);
        getPaymentUrlStub.resolves(expectedPaymentParams);

        const saveResult = await handler.initiatePendingSave(wrapTestEvent(saveEvent));

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxPending);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalPendingRequestToRds);
        expect(findFloatOrIdStub).to.not.have.been.called;
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    it('Throws an error when no account information, currency, unit or amount provided', async () => {
        const saveEventNoAccountId = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAccountId, 'accountId');
        const saveEventNoAmount = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAmount, 'amount');
        const saveEventNoCurrency = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoCurrency, 'currency');
        const saveEventNoUnit = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoUnit, 'unit');

        const expectedNoAccountError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoAccountId));
        testHelper.checkErrorResultForMsg(expectedNoAccountError, 'Error! No account ID provided for the save');

        const expectedNoAmountError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoAmount));
        const expectedNoCurrencyError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoCurrency));
        const expectedNoUnitError = await handler.initiatePendingSave(wrapTestEvent(saveEventNoUnit));

        testHelper.checkErrorResultForMsg(expectedNoAmountError, 'Error! No amount provided for the save');
        testHelper.checkErrorResultForMsg(expectedNoCurrencyError, 'Error! No currency specified for the saving event');
        testHelper.checkErrorResultForMsg(expectedNoUnitError, 'Error! No unit specified for the saving event');
    });
    
});
