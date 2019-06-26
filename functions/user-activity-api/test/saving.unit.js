process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:save:test');

const chai = require('chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const testAccountId = uuid();
const testTimeInitiated = Date.now() - 5000;
const testTimeSettled = Date.now() - 100;

const testAmounts = [ 100, 10, 5, 6.70 ].map((amount) => amount * 100);
logger('Setting up, test amounts: ', testAmounts);

let findMatchingTxStub = sinon.stub();
let findFloatStub = sinon.stub();
let addSavingsRdsStub = sinon.stub();

const handler = proxyquire('../handler', {
    './persistence/rds': { 
        'findMatchingTransaction': findMatchingTxStub,
        'findFloatForAccount': findFloatStub, 
        'addSavingToTransactions': addSavingsRdsStub,
    },
    '@noCallThru': true
});

const resetStubs = () => {
    findMatchingTxStub.reset();
    addSavingsRdsStub.reset();
};

describe('User saves, without reward, sync or async', () => {

    beforeEach(() => resetStubs());

    const testSaveSettlementBase = (amount = testAmounts[0]) => ({
        accountId: testAccountId,
        timeInitiated: testTimeInitiated,
        timeSettled: testTimeSettled,
        savedAmount: amount,
        savedCurrency: 'ZAR',
        savedUnit: 'HUNDREDTH_CENT'
    });

    it('Saves, with payment at same time, but no float explicit', async () => {
        const saveEvent = JSON.parse(JSON.stringify(testSaveSettlementBase()));
        saveEvent.paymentRef = uuid();

        const expectedTxDetails = { accountTransactionId: uuid(), floatTransactionId: uuid() };
        findFloatStub.withArgs(testAccountId).resolves('zar_cash_float');
        addSavingsRdsStub.withArgs(saveEvent, 'zar_cash_float').resolves({ rows: [expectedTxDetails] });

        const saveResult = await handler.save(saveEvent);
        
        expect(saveResult).to.exist;
        expect(saveResult.statusCode).to.equal(200);
        expect(saveResult.body).to.exist;
        const saveBody = JSON.parse(saveResult.body);
        expect(saveBody).to.deep.equal({ 'state': 'SETTLED', 'transactionIds': expectedTxDetails });
        expect(findFloatStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(addSavingsRdsStub).to.have.been.calledOnceWithExactly(saveEvent);
        expect(findMatchingTxStub).to.have.not.been.called;
    });

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

});
