'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:save:test');

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
const testClientId = 'some_savings_co';
const testFloatId = 'usd_primary_float';
const testPaymentRef = 'some_ref_at_bank';

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

const handler = proxyquire('../saving-handler', {
    './persistence/rds': { 
        'findMatchingTransaction': findMatchingTxStub,
        'findClientAndFloatForAccount': findFloatStub, 
        'addSavingToTransactions': addSavingsRdsStub
    },
    '@noCallThru': true
});

const resetStubHistory = () => {
    findMatchingTxStub.resetHistory();
    findFloatStub.resetHistory();
    addSavingsRdsStub.resetHistory();
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
        paymentRef: testPaymentRef
    });

    // const testSavePendingBase = (amount = testAmounts[0]) => ({

    // });

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
        paymentRef: testPaymentRef
    };

    const wellFormedMinimalPendingRequestToRds = JSON.parse(JSON.stringify(wellFormedMinimalSettledRequestToRds));
    Reflect.deleteProperty(wellFormedMinimalPendingRequestToRds, 'settledTime');
    wellFormedMinimalPendingRequestToRds.savedAmount = sinon.match.number;
    wellFormedMinimalPendingRequestToRds.settlementStatus = 'PENDING';

    const responseToTxSettled = {
        transactionDetails: [{ accountTransactionId: uuid(), creationTime: moment().format() }, 
            { floatAdditionTransactionId: uuid(), creationTime: moment().format() },
            { floatAllocationTransactionId: uuid(), creationTime: moment().format() }],
        newBalance: { amount: sumOfTestAmounts, unit: 'HUNDREDTH_CENT' }
    };

    const responseToTxPending = {
        transactionDetails: [{ accountTransactionId: uuid(), creationTime: moment().format() }]
    };

    before(() => {
        findFloatStub.withArgs(testAccountId).resolves({ clientId: testClientId, floatId: testFloatId });
        addSavingsRdsStub.withArgs(sinon.match(wellFormedMinimalSettledRequestToRds)).resolves(responseToTxSettled);
        addSavingsRdsStub.withArgs(wellFormedMinimalPendingRequestToRds).resolves(responseToTxPending);
    });

    beforeEach(() => resetStubHistory());

    it('Saves, with payment at same time, and client and float explicit', async () => {
        const saveEventWellFormed = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        
        const saveResult = await handler.save(saveEventWellFormed);
        
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
        
        const saveResult = await handler.save(saveEvent);
        
        expect(saveResult).to.have.property('statusCode', 200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal(responseToTxSettled);
        expect(findFloatStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(wellFormedMinimalSettledRequestToRds);
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    /*     
        
    restore this when do non-settled payment
    it('Stores pending, if no payment information, float provided but redundant', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        saveEvent.floatId = 'zar_cash_float';

        const expectedTxDetails = { accountTransactionId: uuid() };
        addSavingsRdsStub.withArgs(settlementWithoutPayment, null).resolves({ rows: [expectedTxDetails] });

        const saveResult = await handler.save(saveEvent);

        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal({ 'state': 'PENDING', transactionsIds: expectedTxDetails });
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(settlementWithPayment);
        expect(findFloatStub).to.have.not.been.called;
        expect(findMatchingTxStub).to.have.not.been.called;
    });

    */

    it('Throws an error when no account information, currency, unit or amount provided', async () => {
        const saveEventNoAccountId = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAccountId, 'accountId');
        const saveEventNoAmount = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoAmount, 'savedAmount');
        const saveEventNoCurrency = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoCurrency, 'savedCurrency');
        const saveEventNoUnit = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        Reflect.deleteProperty(saveEventNoUnit, 'savedUnit');

        const expectedNoAccountError = await handler.save(saveEventNoAccountId);
        testHelper.checkErrorResultForMsg(expectedNoAccountError, 'Error! No account ID provided for the save');

        const expectedNoAmountError = await handler.save(saveEventNoAmount);
        const expectedNoCurrencyError = await handler.save(saveEventNoCurrency);
        const expectedNoUnitError = await handler.save(saveEventNoUnit);

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
