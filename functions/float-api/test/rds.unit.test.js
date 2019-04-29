process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

const uuid = require('uuid/v4');

const proxyquire = require('proxyquire');

// for the moment, these are all we need
var queryStub = sinon.stub();
class MockPostgres {
    constructor(any) {
        this.connect = () => Promise.resolve({query: queryStub});
    }
}

const rds = proxyquire('../persistence/rds', {
    'pg': { Pool: MockPostgres },
    '@noCallThru': true
});

const config = require('config');
const common = require('./common');
const constants = require('../constants');

// todo: think through tests all failure cases (e.g., accrual doesn't execture, accrual does but bonus share doesn't, etc.)

describe('Accrual happy paths', () => {

    const testAccrualInstruction = {
        clientId: common.testValidClientId,
        floatId: common.testValidClientId,
        amount: common.testValueAccrualSize,
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        relatedId: 'mmkt_backing_trans_id',
        relatedType: 'EXTERNAL'
    };

    const stubTransactionId = uuid();

    // todo : think through transaction management in here; 
    const expectedQuery = `insert into ${config.get('tables.floatTransactions')} ` 
        + `(transaction_id, client_id, float_id, t_type, currency, unit, amount, related_entity_id, related_entity_type) `
        + `values ($1, $2, $3, ${constants.floatTransTypes.ACCRUAL}, $4, $5, $6, $7) returning transaction_id`;
    const expectedValues = [stubTransactionId, 
        testAccrualInstruction.clientId, 
        testAccrualInstruction.floatId, 
        testAccrualInstruction.currency, 
        testAccrualInstruction.currency, 
        testAccrualInstruction.amount,
        testAccrualInstruction.relatedId,
        testAccrualInstruction.relatedType];

    before(() => {
        queryStub.resolves(stubTransactionId);
    });

    after(() => {
        queryStub.reset();
    })

    it('Inserts a float accrual correctly', async () => {
        const allocationResult = await rds.allocateFloat(testAccrualInstruction);
        logger('Finished allocation');
        expect(allocationResult).to.exist;
        expect(allocationResult).to.equal(stubTransactionId);
        expect(queryStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledWith(expectedQuery, expectedValues);
    });
});

// todo : think & probe maths in here hard (rounding), including errors
describe('Company and bonus share allocations', () => {

    const testPriorAccrualId = uuid();

    const testBonusAllocation = {
        clientId: common.testValidClientId,
        floatId: common.testValidFloatId,
        amount: Math.round(common.testValueAccrualSize * common.testValueBonusPoolShare),
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        allocatedTo: common.testValueBonusPoolTracker,
        accrualId: testPriorAccrualId
    };

    const testCompanyAllocation = {
        clientId: common.testValidClientId,
        floatId: common.testValidFloatId,
        amount: Math.round(common.testValueAccrualSize * common.testValueCompanyShare),
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        allocatedTo: common.testValueClientCompanyTracker,
        accrualId: testPriorAccrualId
    };

    const stubBonusAllocationId = uuid();
    const stubCompanyAllocationId = uuid();

    const expectedQuery = `insert into ${config.get('tables.floatTransactions')} ` + 
        `(transaction_id, client_id, float_id, t_type, currency, unit, amount, alocation_to_id, related_entity_id, related_entity_type) ` 
        + `values ($1, $2, $3, ${constants.floatTransTypes.ALLOCATION}, $4, $5, $6, $7, $8, $9) returning transaction_id`;
    
    const expectValuesBonus = [stubBonusAllocationId, 
        testBonusAllocation.clientId, 
        testBonusAllocation.floatId, 
        testBonusAllocation.currency, 
        testBonusAllocation.unit,
        testBonusAllocation.amount,
        testBonusAllocation.allocatedTo,
        testBonusAllocation.accrualId,
        constants.floatTransTypes.ACCRUAL];

    const expectValuesCompany = [stubCompanyAllocationId, 
            testCompanyAllocation.clientId, 
            testCompanyAllocation.floatId, 
            testCompanyAllocation.currency, 
            testCompanyAllocation.unit,
            testCompanyAllocation.amount,
            testCompanyAllocation.allocatedTo,
            testCompanyAllocation.accrualId,
            constants.floatTransTypes.ACCRUAL];

    before(() => {
        queryStub.resolves([stubBonusAllocationId]);
    });

    after(() => {
        queryStub.reset();
    });

    it('Allocates the bonus pool correctly', async () => {
        const queryResult = await rds.allocateFloat([testBonusAllocation]);
        logger('Completed bonus allocation query');
        expect(queryResult).to.exist;
        expect(queryResult).to.equal([stubBonusAllocationId]);
        expect(queryStub).to.have.been.calledThrice;
        expect(queryStub).to.have.been.calledWith('begin');
        expect(queryStub).to.have.been.calledWith(expectedQuery, expectValuesBonus);
        expect(queryStub).to.have.been.calledWith('end');
    });

    it('Allocates the client company share correctly', async () => {
        const queryResult = await rds.allocateFloat([testCompanyAllocation]);
        logger('Completed company allocation query');
        expect(queryResult).to.exist;
        expect(queryResult).to.equal([stubCompanyAllocationId]);
        expect(queryStub).to.have.been.calledThrice;
        expect(queryStub).to.have.been.calledWith('begin');
        expect(queryStub).to.have.been.calledWith(expectedQuery, expectValuesCompany);
        expect(queryStub).to.have.been.calledWith('end');
    });

});

describe.only('User account allocation', () => {

    const generateUids = (numberUsers) => Array(numberUsers).fill().map(_ => uuid());
    const baseAllocationRequest = {
        clientId: common.testValidClientId,
        floatId: common.testValidFloatId,
        currency: 'ZAR',
        unit: constants.floatTransTypes.DEFAULT
    };

    const generateUserAllocationRequests = (amountAllocations) => {
        const numberUsers = amountAllocations.length;
        
        const userIds = generateUids(numberUsers);
        const accountIds = generateUids(numberUsers);

        const requests = amountAllocations.map((amount, idx) => {
            const newRequest = JSON.parse(JSON.stringify(baseAllocationRequest));
            newRequest['amount'] = amount;
            newRequest['accountId'] = accountIds[idx];
            newRequest['userId'] = userIds[idx];
            return newRequest;
        });

        return requests;
    };

    const generateAllocations = (numberOfUsers, maxAllocation) => {
        const allocationAmounts = Array(numberOfUsers).fill().map(_ => Math.round(Math.random() * maxAllocation));
        return generateUserAllocationRequests(allocationAmounts);
    }

    before(() => {
        queryStub.resolves();
    });

    after(() => {
        queryStub.reset();
    });

    it('Persists a large number of allocations correctly', async () => {
        // const queryResult = await rds.allocateToUsers();
        const allocRequests = generateAllocations(10000, 1e3 * 1e4); // a hundred rand in hundredth cents (as daily interest, equals ind account of R1m roughly)
        const insertionResult = await rds.allocateToUsers(allocRequests);
        expect(insertionResult).to.exist;
        expect(queryStub).to.be.calledThrice; // actually will be 4 times
        expect(queryStub).to.be.calledWith('begin');
        expect(queryStub).to.be.calledWith('insert into floats');
        expect(queryStub).to.be.calledWith('insert into accounts');
        expect(queryStub).to.be.calledWith('end');
    });

});


describe.only('Test integrity check', () => {
    it('Will fail if stub is not properly reset somewhere else in tests', async () => {
        const queryResult = await rds.addOrSubtractFloat();
        expect(queryResult).to.be.undefined;
    })
})