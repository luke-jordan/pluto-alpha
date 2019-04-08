process.env.NODE_ENV = 'test';

const logger = require('debug')('u:account:test')
const config = require('config');

const chai = require('chai');
const expect = chai.expect;

const uuid = require('uuid/v4');
chai.use(require('chai-uuid'));

const testAccountId = uuid();
const testTimeInitiated = Date.now() - 5000;
const testTimeSettled = Date.now() - 100;

const testAmounts = [ 100, 10, 5, 6.70 ].map(amount => amount * 100)
logger('Setting up, test amounts: ', testAmounts);

const handler = require('../handler')

describe('User just saves (without offer, puzzle, etc)', () => {

    it('Normal saving, happy path', async () => {
        logger('Second API tests initiating');

        logger('We will use this account UID: ', testAccountId);

        // testAmountSettles();
        await Promise.all(testAmounts.map(amount => testAmountSettles(amount)));
    });

});

const testAmountSettles = async (amount = testAmounts[0]) => {
    const testSaveSettlementBase = {
        accountId: testAccountId,
        timeInitiated: testTimeInitiated,
        timeSettled: testTimeSettled,
        amount: amount
    };

    saveResult = await handler.storeSettledSaving(testSaveSettlementBase);
    expect(saveResult).to.not.be.undefined;
    expect(saveResult.statusCode).to.equal(200);
    expect(saveResult.entity).to.exist;
}
