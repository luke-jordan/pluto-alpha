'use strict';

const helper = require('./test.helper');

const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();

const BigNumber = require('bignumber.js');

const common = require('./common');
const constants = require('../constants');

const fetchFloatConfigVarsStub = sinon.stub();

const adjustFloatBalanceStub = sinon.stub();
const allocateFloatBalanceStub = sinon.stub();
const calculateFloatBalanceStub = sinon.stub();
const obtainEntityBalanceStub = sinon.stub();
const fetchRecordsRelatedToLog = sinon.stub();
const writeCsvFileStub = sinon.stub();

const obtainAccountBalancesStub = sinon.stub();
const allocateToUsersStub = sinon.stub();

const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();
const redisDelStub = sinon.stub();

const allocationStub = sinon.stub();

const mockRds = { 
    addOrSubtractFloat: adjustFloatBalanceStub,
    allocateFloat: allocateFloatBalanceStub,
    calculateFloatBalance: calculateFloatBalanceStub,
    obtainPriorAllocationBalances: obtainEntityBalanceStub,
    fetchRecordsRelatedToLog: fetchRecordsRelatedToLog,
    obtainAllAccountsWithPriorAllocations: obtainAccountBalancesStub,
    allocateToUsers: allocateToUsersStub
};

const handler = proxyquire('../accrual-handler', {
    './persistence/dynamodb': { 
        fetchConfigVarsForFloat: fetchFloatConfigVarsStub,
        '@noCallThru': true 
    },
    './persistence/rds': mockRds,
    'ioredis': class {
        constructor () {
            this.get = redisGetStub;
            this.set = redisSetStub;
            this.del = redisDelStub;
        }
    },
    './allocation-helper': {
        allocate: allocationStub
    },
    './persistence/csvfile': {
        writeAndUploadCsv: writeCsvFileStub,
        '@noCallThru': true
    }
});

describe('Single apportionment operations', () => {

    it('Calculate bonus share properly, with random values, plus bonus share', () => {
        // note: e13 = 1 * 10^13 = 1 billion rand (1e9) in hundredths of cents
        const poolExamples = Array.from({length: 10}, () => Math.floor(Math.random() * 1e13));
        const shareExamples = Array.from({length: 3}, () => Math.random());
        shareExamples.push(common.testValueBonusPoolShare);
        shareExamples.push(common.testValueClientShare);

        poolExamples.forEach((pool) => {
            shareExamples.forEach((share) => {
                const expectedResult = new BigNumber(pool).times(new BigNumber(share)).integerValue(BigNumber.ROUND_HALF_UP).toNumber();
                const obtainedResult = handler.calculateShare(pool, share);
                expect(obtainedResult).to.exist;
                expect(obtainedResult).to.be.a('number');
                expect(obtainedResult).to.equal(expectedResult);
            });
        });
    });

    it('Throw an error if passed a bad pool value', () => {
        const badPool1 = 'some_pool_in_numbers!';
        const badPool2 = '1234';
        const badPool3 = 1234.5;

        const share = common.testValueBonusPoolShare;

        expect(handler.calculateShare.bind(handler, badPool1, share)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, badPool2, share)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, badPool3, share)).to.throw(TypeError);
    });

    it('Throw an error if passed a bad share', () => {
        const badShare1 = 'some_share_wrong';
        const badShare2 = 2.5;
        const badShare3 = -1;

        const pool = Math.floor(Math.random() * 1e11);

        expect(handler.calculateShare.bind(handler, pool, badShare1)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, pool, badShare2)).to.throw(RangeError);
        expect(handler.calculateShare.bind(handler, pool, badShare3)).to.throw(RangeError);
    });

});

describe('Primary allocation of inbound accrual lambda', () => {

    beforeEach(() => {
        helper.resetStubs(
            fetchFloatConfigVarsStub, adjustFloatBalanceStub, allocateFloatBalanceStub, 
            calculateFloatBalanceStub, allocationStub, redisGetStub, redisSetStub, redisDelStub);
    });

    it('Handles errors correctly (ie still exits), including releasing state lock', async () => {
        redisGetStub.resolves(null);

        fetchFloatConfigVarsStub.withArgs('some_client', 'some_float').throws(new Error('That went wrong!'));
        const badEvent = { clientId: 'some_client', floatId: 'some_float', backingEntityIdentifier: 'some_id'};
        const expectedErrorReturn = await handler.accrue(badEvent);
        
        expect(expectedErrorReturn).to.exist;
        expect(expectedErrorReturn).to.have.property('statusCode', 500);

        expect(redisSetStub).to.have.been.calledOnceWithExactly('some_client::some_float::some_id', JSON.stringify(badEvent), 'EX', 300);
        expect(redisDelStub).to.have.been.calledOnceWithExactly('some_client::some_float::some_id');
    });

    it('Aborts if state lock in place', async () => {
        // just using what exists
        const duplicatedEvent = { clientId: 'some_client', floatId: 'some_float', backingEntityIdentifier: 'some_id'};
        redisGetStub.resolves('some_client::some_float::some_id').resolves(JSON.stringify(duplicatedEvent));

        const response = await handler.accrue(duplicatedEvent);
        expect(response).to.deep.equal({ statusCode: 200, body: 'STATE_LOCKED' });

        expect(redisSetStub).to.not.have.been.called;
        expect(fetchFloatConfigVarsStub).to.not.have.been.called;
        expect(adjustFloatBalanceStub).to.not.have.been.called;
    });

    it('Check initial accrual, no state lock, no existing log', async () => {
        const testBonusPoolId = helper.commonFloatConfig.bonusPoolTracker;
        const testClientCoId = helper.commonFloatConfig.clientCoShareTracker;

        // thousands of rand, in hundredths of a cent
        const amountAccrued = Math.floor(Math.random() * 1000 * 10000);  
        const testTxIds = Array(10).fill().map(() => uuid());
        const referenceTimeMillis = moment().valueOf();
        const testLogId = uuid();

        const accrualEvent = {
            clientId: common.testValidClientId,
            floatId: common.testValidFloatId,
            accrualAmount: amountAccrued,
            currency: 'ZAR',
            unit: constants.floatUnits.HUNDREDTH_CENT,
            backingEntityIdentifier: 'system-calc-X',
            referenceTimeMillis
        };

        const expectedFloatAdjustment = { ...accrualEvent, transactionType: 'ACCRUAL', backingEntityType: 'ACCRUAL_EVENT' };
        Reflect.deleteProperty(expectedFloatAdjustment, 'accrualAmount');
        expectedFloatAdjustment.amount = amountAccrued;
        expectedFloatAdjustment.logType = 'WHOLE_FLOAT_ACCRUAL';

        redisGetStub.resolves(null);
        redisSetStub.resolves('OK');

        fetchFloatConfigVarsStub.withArgs(common.testValidClientId, common.testValidFloatId).resolves(helper.commonFloatConfig);
        calculateFloatBalanceStub.resolves({ balance: 100, unit: constants.floatUnits.HUNDREDTH_CENT });
        
        adjustFloatBalanceStub.withArgs(expectedFloatAdjustment).resolves({ updatedBalance: 100 + amountAccrued, logId: testLogId });

        obtainEntityBalanceStub.resolves(new Map([[testBonusPoolId, 10], [testClientCoId, 5]]));

        const expectedBonusAllocationAmount = Math.round(amountAccrued * common.testValueBonusPoolShare);
        const expectedClientCoAmount = Math.round(amountAccrued * common.testValueClientShare);

        const expectedGrossAmount = amountAccrued - expectedBonusAllocationAmount - expectedClientCoAmount;
        const expectedBonusShare = Math.round(0.1 * expectedGrossAmount);
        const expectedClientShare = Math.round(0.05 * expectedGrossAmount); 

        const expectedUserAmount = amountAccrued - expectedBonusAllocationAmount - expectedClientCoAmount - expectedBonusShare - expectedClientShare;

        const entityAllocation = (entityType, entityId, amount, label) => ({ 
            label,
            amount,
            currency: accrualEvent.currency, 
            unit: accrualEvent.unit,
            transactionType: 'ACCRUAL', 
            transactionState: 'SETTLED',
            allocatedToId: entityId,
            allocatedToType: entityType,
            relatedEntityId: accrualEvent.backingEntityIdentifier,
            relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,    
            logId: testLogId
        });
        
        const expectedBonusFeeAllocation = entityAllocation('BONUS_POOL', testBonusPoolId, expectedBonusAllocationAmount, 'BONUS_FEE');
        const expectedBonusShareAlloc = entityAllocation('BONUS_POOL', testBonusPoolId, expectedBonusShare, 'BONUS_SHARE');
        const expectedClientCoAllocation = entityAllocation('COMPANY_SHARE', testClientCoId, expectedClientCoAmount, 'CLIENT_FEE');
        const expectedClientShareAlloc = entityAllocation('COMPANY_SHARE', testClientCoId, expectedClientShare, 'CLIENT_SHARE');

        allocateFloatBalanceStub.resolves([{ 'BONUS_FEE': uuid() }, { 'CLIENT_FEE': uuid() }, { 'BONUS_SHARE': uuid() }, { 'CLIENT_SHARE': uuid() }]);

        const userAllocEvent = {
            clientId: common.testValidClientId, floatId: common.testValidFloatId, 
            totalAmount: expectedUserAmount,
            currency: 'ZAR',
            unit: accrualEvent.unit,
            transactionType: 'ACCRUAL',
            transactionState: 'SETTLED',
            backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
            backingEntityIdentifier: accrualEvent.backingEntityIdentifier,
            bonusPoolIdForExcess: common.testValueBonusPoolTracker,
            logId: testLogId
        };

        // we test bonus allocation of any fractional amount in the tests below, so here just set to none
        allocationStub.resolves({ allocationRecords: testTxIds, bonusAllocation: { } });
        
        // and last we test the record keeping
        const mockRecords = [{ 'first_column': 'some-id', 'second_column': 60 }, { 'first_column': 'another-id', 'second_column': 80 }];
        fetchRecordsRelatedToLog.resolves(mockRecords);
        writeCsvFileStub.resolves('s3://bucket/somekey');
        
        const response = await handler.accrue(accrualEvent);

        // expect the state to be set
        const expectedStateLockKey = `${common.testValidClientId}::${common.testValidFloatId}::system-calc-X`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(expectedStateLockKey);
        expect(redisSetStub).to.have.been.calledWithExactly(expectedStateLockKey, JSON.stringify(accrualEvent), 'EX', 300);

        // expect the config variables to be fetched
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnce;
        
        // expect the float to have its balance adjusted upward
        expect(adjustFloatBalanceStub).to.have.been.calledOnce;
        expect(adjustFloatBalanceStub).to.have.been.calledWith(expectedFloatAdjustment);

        // expect the bonus and company shares to be allocated
        expect(allocateFloatBalanceStub).to.have.been.calledOnce;
        // helper.logNestedMatches(expectedClientCoAllocation, allocateFloatBalanceStub.getCall(0).args[2][1]);
        expect(allocateFloatBalanceStub).to.have.been.calledOnceWithExactly(common.testValidClientId, common.testValidFloatId, 
                [expectedBonusFeeAllocation, expectedClientCoAllocation, expectedBonusShareAlloc, expectedClientShareAlloc]);

        // for now we are going to call this method directly; in future will be easy to change it into a queue or async lambda invocation
        expect(allocationStub).to.have.been.calledOnce;
        expect(allocationStub).to.have.been.calledWithExactly(userAllocEvent, mockRds);

        // expect the lambda to then return the correct, well formatted response
        expect(response.statusCode).to.equal(200);
        expect(response.body).to.exist;
        
        const responseEntity = JSON.parse(response.body);
        expect(responseEntity.entityAllocations).to.exist;
        expect(responseEntity.entityAllocations).to.have.keys(['BONUS_FEE', 'CLIENT_FEE', 'BONUS_SHARE', 'CLIENT_SHARE']);
        const clientShare = responseEntity.entityAllocations['CLIENT_FEE']['amount'];
        expect(clientShare).to.be.lessThan(amountAccrued);

        expect(responseEntity.newBalance).to.be.at.least(amountAccrued);
        expect(responseEntity.entityAllocations['BONUS_FEE']['amount']).to.be.lessThan(amountAccrued - clientShare);

        expect(responseEntity.userAllocationTransactions).to.deep.equal({ allocationRecords: testTxIds, bonusAllocation: { } });
    });

});
