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

    const floatTxIds = [uuid(), uuid(), uuid()];
    const accountTxIds = [uuid(), uuid()];

    const poolAllocResult = [{ 'id': floatTxIds[0] }];
    const userAllocResult = {
        floatTxIds: floatTxIds.slice(1).map((id) => ({ 'transaction_id': id})),
        accountTxIds: accountTxIds.map((id) => ({ 'transaction_id': id }))
    };

    const expectedResult = {
        'this_transaction': {
            result: 'SUCCESS',
            floatTxIds,
            accountTxIds 
        }
    };

    it('Happy path, pretty simple, for now', async () => {
        logger('Testing a basic transfer');
        allocatePoolStub.resolves(poolAllocResult);
        allocateUserStub.resolves(userAllocResult);
        const resultOfTransfer = await handler.floatTransfer({ instructions: [testInstruction]});
        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
    });

    it('Happy path, transfer is settled', async () => {
        allocatePoolStub.resolves(poolAllocResult);
        allocateUserStub.resolves(userAllocResult);
        
        const thisInstruction = { ...testInstruction };
        thisInstruction.settlementStatus = 'SETTLED';
        const resultOfTransfer = await handler.floatTransfer({ instructions: [thisInstruction]});
        
        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
    });

});

describe('*** UNIT TEST FLOAT TRANSFER TO BONUS AND COMPANY ***', () => {

    beforeEach(() => { 
        allocatePoolStub.reset(); 
    });

    const testLogId = uuid();

    const recipients = [{
        recipientId: 'some_bonus_pool_used',
        amount: 100,
        recipientType: 'BONUS_POOL'
    }];

    const payload = {
        instructions: [{
            floatId: 'some_float',
            clientId: 'some_client',
            currency: 'USD',
            unit: 'WHOLE_CURRENCY',
            amount: 100,
            identifier: testLogId,
            relatedEntityType: 'ADMIN_INSTRUCTION',
            recipients
        }]
    };

    it('Single allocation to bonus pool', async () => {
        const floatTxIds = [uuid()];
        const poolAllocResult = [{ 'id': floatTxIds[0] }];
        const expectedResult = {
            [testLogId]: {
                result: 'SUCCESS',
                floatTxIds,
                accountTxIds: [] 
            }
        };    
        
        allocatePoolStub.resolves(poolAllocResult);

        const resultOfTransfer = await handler.floatTransfer(payload);
        
        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
    });

    it('Single negative allocation from company to bonus', async () => {
        const newPayload = { ...payload };
        newPayload.instructions[0].fromType = 'COMPANY_SHARE';

        const floatTxIds = [uuid(), uuid()];
        const poolAllocResult = [{ 'id': floatTxIds[0] }, { 'id': floatTxIds[1] }];
        const expectedResult = {
            [testLogId]: {
                result: 'SUCCESS',
                floatTxIds,
                accountTxIds: []
            }
        };

        allocatePoolStub.resolves(poolAllocResult);

        const resultOfTransfer = await handler.floatTransfer(newPayload);

        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
    });

});
