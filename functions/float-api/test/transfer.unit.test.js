'use strict';

const logger = require('debug')('jupiter:float:transfer:test');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');

const testFloatId = 'vnd_primary_cash';
const testBonusPoolId = 'bonus_pool';

const testAmount = 1000;
const testCurrency = 'VND';
const testUnit = 'WHOLE_CURRENCY';
const constants = require('../constants');

const allocatePoolStub = sinon.stub();
const allocateUserStub = sinon.stub();

const handler = proxyquire('../transfer-handler', {
    './persistence/rds': {
        'allocateFloat': allocatePoolStub,
        'allocateToUsers': allocateUserStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST BONUS TRANSFER ***', () => {

    const testAccountIds = [uuid(), uuid()];
    const testRecipients = testAccountIds.map((accountId) => ({
        recipientId: accountId, amount: testAmount, recipientType: 'END_USER_ACCOUNT' 
    }));

    const testInstruction = {
        identifier: 'this_transaction',
        floatId: testFloatId,
        fromId: testBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: testCurrency,
        unit: testUnit,
        relatedEntityType: constants.entityTypes.BOOST_EVENT,
        recipients: testRecipients
    };

    const expectedResult = {
        'this_transaction': {
            result: 'SUCCESS' ,
            floatTxIds: [uuid(), uuid(), uuid()],
            accountTxIds: [uuid(), uuid()]
        }
    };

    it.only('Happy path, pretty simple, for now', async () => {
        const resultOfTransfer = await handler.floatTransfer({ instructions: [testInstruction]});
        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
    });

});