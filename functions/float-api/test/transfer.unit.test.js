'use strict';

const logger = require('debug')('jupiter:float:transfer:test');
const config = require('config');
const uuid = require('uuid/v4');
const uuid5 = require('uuid/v5');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();
const helper = require('./test.helper');

const testClientId = 'some_client_co';
const testFloatId = 'vnd_primary_cash';
const testBonusPoolId = 'bonus_pool';

const testAmount = 1000;
const testCurrency = 'VND';
const testUnit = 'WHOLE_CURRENCY';
const constants = require('../constants');

const allocatePoolStub = sinon.stub();
const allocateUserStub = sinon.stub();
const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();

class MockRedis {
    constructor () { 
        this.get = redisGetStub;
        this.set = redisSetStub;
    }
}

const handler = proxyquire('../transfer-handler', {
    './persistence/rds': {
        'allocateFloat': allocatePoolStub,
        'allocateToUsers': allocateUserStub,
        '@noCallThru': true
    },
    './persistence/dynamodb': {
        '@noCallThru': true
    },
    './accrual-handler': {
        '@noCallThru': true
    },
    'ioredis': MockRedis,
    '@noCallThru': true
});

describe('*** UNIT TEST BONUS TRANSFER ***', () => {

    const testAccountIds = [uuid(), uuid()];
    const testRecipients = testAccountIds.map((accountId) => ({
        recipientId: accountId, amount: testAmount, recipientType: 'END_USER_ACCOUNT' 
    }));

    const testInstruction = {
        identifier: 'this_transaction',
        clientId: testClientId,
        floatId: testFloatId,
        fromId: testBonusPoolId,
        fromType: 'BONUS_POOL',
        currency: testCurrency,
        unit: testUnit,
        settlementStatus: 'PENDING',
        transactionType: 'ALLOCATION',
        relatedEntityType: constants.entityTypes.BONUS_POOL,
        recipients: testRecipients
    };

    const testNonUserAllocRequest = [{
        amount: -2000,
        allocatedToType: 'BONUS_POOL',
        allocatedToId: 'bonus_pool',
        unit: 'WHOLE_CURRENCY',
        currency: 'VND',
        transactionType: 'ALLOCATION',
        relatedEntityType: 'BONUS_POOL',
        relatedEntityId: 'this_transaction'
    }];

    const testUserAllocRequests = (settlementStatus) => testAccountIds.map((accountId) => ({
        amount: 1000,
        unit: 'WHOLE_CURRENCY',
        currency: 'VND',
        accountId: accountId,
        allocType: 'ALLOCATION',
        allocState: settlementStatus,
        settlementStatus: settlementStatus,
        relatedEntityType: 'BONUS_POOL',
        relatedEntityId: 'this_transaction'
    }));

    const floatTxIds = [uuid(), uuid(), uuid()];
    const accountTxIds = [uuid(), uuid()];
    const testActiveTxId = uuid5(JSON.stringify(testInstruction), config.get('cache.namespace'));

    const poolAllocResult = [{ 'id': floatTxIds[0] }];
    const userAllocResult = {
        floatTxIds: floatTxIds.slice(1),
        accountTxIds
    };

    const testTxResult = {
        id: 'this_transaction', 
        details: {
            result: 'SUCCESS',
            floatTxIds,
            accountTxIds
        }
    };

    const expectedResult = {
        'this_transaction': {
            result: 'SUCCESS',
            floatTxIds,
            accountTxIds 
        }
    };

    beforeEach(() => {
        helper.resetStubs(allocatePoolStub, allocateUserStub, redisGetStub, redisSetStub);
    });

    it('Happy path, pretty simple, for now', async () => {
        logger('Testing a basic transfer');
        
        allocatePoolStub.resolves(poolAllocResult);
        allocateUserStub.resolves(userAllocResult);
        
        redisGetStub.resolves(null);
        redisSetStub.resolves('OK');

        const resultOfTransfer = await handler.floatTransfer({ instructions: [testInstruction]});
        // logger('Result in full: ', resultOfTransfer);

        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
        expect(allocatePoolStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId, testNonUserAllocRequest);
        expect(allocateUserStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId, testUserAllocRequests('PENDING'));
        expect(redisGetStub).to.have.been.calledOnceWithExactly(testActiveTxId);
        expect(redisSetStub).to.have.been.calledWithExactly(testActiveTxId, 'PENDING', 'EX', config.get('cache.ttls.float'));
        expect(redisSetStub).to.have.been.calledWithExactly(testActiveTxId, JSON.stringify(testTxResult), 'EX', config.get('cache.ttls.float'));
        expect(redisSetStub).to.have.been.calledTwice;
    });

    // eslint-disable-next-line
    it('Handles pending transactions', async function () {
        // eslint-disable-next-line
        this.timeout(15000);
        redisGetStub.onFirstCall().resolves('PENDING');
        redisGetStub.onSecondCall().resolves(JSON.stringify(testTxResult));
        
        const resultOfTransfer = await handler.floatTransfer({ instructions: [testInstruction]});

        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
        expect(redisGetStub).to.have.been.calledWithExactly(testActiveTxId);
        expect(redisGetStub).to.have.been.calledTwice;
        expect(redisSetStub).to.have.not.been.called;
        expect(allocatePoolStub).to.have.not.been.called;
        expect(allocateUserStub).to.have.not.been.called;
    });

    it('Happy path, transfer is settled', async () => {
        allocatePoolStub.resolves(poolAllocResult);
        allocateUserStub.resolves(userAllocResult);
        redisGetStub.resolves(null);
        redisSetStub.resolves('OK');
        
        const thisInstruction = { ...testInstruction };
        thisInstruction.settlementStatus = 'SETTLED';
        const resultOfTransfer = await handler.floatTransfer({ instructions: [thisInstruction]});

        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
        expect(allocatePoolStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId, testNonUserAllocRequest);
        expect(allocateUserStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId, testUserAllocRequests('SETTLED'));
    });
});

describe('*** UNIT TEST FLOAT TRANSFER TO BONUS AND COMPANY ***', () => {

    beforeEach(() => {
        helper.resetStubs(allocatePoolStub, allocateUserStub);
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
            transactionType: 'ALLOCATION',
            relatedEntityType: 'ADMIN_INSTRUCTION',
            recipients
        }]
    };

    const testAllocToBonusPool = [{
        amount: 100,
        allocatedToType: 'BONUS_POOL',
        allocatedToId: 'some_bonus_pool_used',
        unit: 'WHOLE_CURRENCY',
        currency: 'USD',
        transactionType: 'ALLOCATION',
        relatedEntityType: 'ADMIN_INSTRUCTION',
        relatedEntityId: testLogId
    }];

    const testAllocFromCompanyToBonusPool = [{
            amount: -100,
            allocatedToType: 'COMPANY_SHARE',
            allocatedToId: 'some_identifier',
            unit: 'WHOLE_CURRENCY',
            currency: 'USD',
            transactionType: 'ALLOCATION',
            relatedEntityType: 'ADMIN_INSTRUCTION',
            relatedEntityId: testLogId
        },
        testAllocToBonusPool[0]
    ];

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
        redisGetStub.resolves(null);
        redisSetStub.resolves('OK');

        const resultOfTransfer = await handler.floatTransfer(payload);
        
        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
        expect(allocatePoolStub).to.have.been.calledOnceWithExactly('some_client', 'some_float', testAllocToBonusPool);
        expect(allocateUserStub).to.have.not.been.called;
    });

    it('Single negative allocation from company to bonus', async () => {
        const newPayload = { ...payload };
        newPayload.instructions[0].fromType = 'COMPANY_SHARE';
        newPayload.instructions[0].fromId = 'some_identifier';

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
        redisGetStub.resolves(null);
        redisSetStub.resolves('OK');

        const resultOfTransfer = await handler.floatTransfer(newPayload);

        expect(resultOfTransfer).to.exist;
        expect(resultOfTransfer).to.have.property('statusCode', 200);
        expect(resultOfTransfer).to.have.property('body');
        
        const bodyOfResult = JSON.parse(resultOfTransfer.body);
        expect(bodyOfResult).to.deep.equal(expectedResult);
        expect(allocatePoolStub).to.have.been.calledOnceWithExactly('some_client', 'some_float', testAllocFromCompanyToBonusPool);
        expect(allocateUserStub).to.have.not.been.called;
    });

});
