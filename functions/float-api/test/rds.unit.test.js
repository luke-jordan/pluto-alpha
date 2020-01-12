'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:float:test');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);
chai.use(require('chai-as-promised'));

// const testHelper = require('./test.helper');

const uuid = require('uuid/v4');

const proxyquire = require('proxyquire');

// for the moment, these are all we need
const queryStub = sinon.stub();
const insertStub = sinon.stub();
const multiTableStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.largeMultiTableInsert = multiTableStub;
    }
}

const rds = proxyquire('../persistence/rds', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => {
    queryStub.reset();
    insertStub.reset();
    multiTableStub.reset();
};

const config = require('config');
const common = require('./common');
const constants = require('../constants');

// todo: think through tests all failure cases (e.g., accrual doesn't execture, accrual does but bonus share doesn't, etc.)
describe('Float balance add or subtract', () => {

    let balanceStub = { };
    const testOpeningBalance = Math.floor(100000 * 100 * 100 * Math.random());

    before(() => {
        resetStubs();
        balanceStub = sinon.stub(rds, 'calculateFloatBalance');
    });

    beforeEach(() => {
        resetStubs();
        balanceStub.reset();
    });

    after(() => {
        rds.calculateFloatBalance.restore();
    });

    it('Adds appropriately to float', async () => {
        const refTime = moment();

        const floatBalanceAdjustment = {
            transactionId: uuid(),
            clientId: common.testValidClientId,
            floatId: common.testValidFloatId,
            transactionType: constants.floatTransTypes.ACCRUAL,
            amount: Math.floor(1000 * 100 * 100 * Math.random()),
            currency: 'ZAR',
            unit: constants.floatUnits.HUNDREDTH_CENT,
            backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
            backingEntityIdentifier: uuid(),
            logType: 'WHOLE_FLOAT_ACCRUAL',
            referenceTimeMillis: refTime.valueOf()
        };

        const query = `insert into ${config.get('tables.floatTransactions')} (transaction_id, client_id, float_id, t_type, t_state, currency, unit, ` +
            `amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id`;
        const columns = common.allocationExpectedColumns;
        const expectedRow = {
            'transaction_id': floatBalanceAdjustment.transactionId,
            'client_id': common.testValidClientId,
            'float_id': common.testValidFloatId,
            't_type': constants.floatTransTypes.ACCRUAL,
            't_state': 'SETTLED',
            'currency': 'ZAR',
            'unit': floatBalanceAdjustment.unit,
            'amount': floatBalanceAdjustment.amount,
            'allocated_to_type': constants.entityTypes.FLOAT_ITSELF,
            'allocated_to_id': common.testValidFloatId,
            'related_entity_type': constants.entityTypes.ACCRUAL_EVENT,
            'related_entity_id': floatBalanceAdjustment.backingEntityIdentifier
        };

        const expectedTxDef = {
            query,
            columnTemplate: columns,
            rows: [expectedRow]
        };

        const logQuery = `insert into ${config.get('tables.floatLogs')} (log_id, reference_time, client_id, float_id, log_type) ` +
            `values %L returning log_id, creation_time`;
        const logToInsert = {
            logId: sinon.match.any,
            clientId: common.testValidClientId,
            floatId: common.testValidFloatId,
            referenceTime: refTime.format(),
            logType: 'WHOLE_FLOAT_ACCRUAL'
        };
        const logInsertDef = {
            query: logQuery,
            columnTemplate: '${logId}, ${referenceTime}, ${clientId}, ${floatId}, ${logType}',
            rows: [logToInsert] 
        };
        const mockLogId = uuid();

        multiTableStub.resolves([[{ 'transaction_id': floatBalanceAdjustment.transactionId }], [{ 'log_id': mockLogId }]]);
        
        // tested extensively elsewhere
        balanceStub.withArgs(common.testValidFloatId, 'ZAR').resolves({ balance: floatBalanceAdjustment.amount + testOpeningBalance, 
            unit: constants.floatUnits.DEFAULT }); // leaving off earliest and latest TX as tested below, and not relevant (yet)

        const adjustmentResult = await rds.addOrSubtractFloat(floatBalanceAdjustment);
        
        expect(adjustmentResult).to.exist;
        expect(adjustmentResult).to.deep.equal({
            updatedBalance: testOpeningBalance + floatBalanceAdjustment.amount,
            unit: constants.floatUnits.HUNDREDTH_CENT,
            transactionId: floatBalanceAdjustment.transactionId,
            logId: mockLogId
        });

        // following is painful but necessary else need a lot of convolution stubbing uuid etc
        const tableArgs = multiTableStub.getCall(0).args;
        expect(tableArgs.length).to.equal(1);
        expect(tableArgs[0]).to.be.an('array').of.length(2);
        expect(tableArgs[0][0]).to.deep.equal(expectedTxDef);        
        expect(sinon.match(logInsertDef).test(tableArgs[0][1])).to.be.true;
    });

    it('Fails on invalid or missing parameters', async () => {
        const refTime = moment();

        const floatBalanceAdjustment = {
            transactionId: uuid(),
            clientId: common.testValidClientId,
            floatId: common.testValidFloatId,
            transactionType: constants.floatTransTypes.ACCRUAL,
            amount: Math.floor(1000 * 100 * 100 * Math.random()),
            currency: 'ZAR',
            unit: constants.floatUnits.HUNDREDTH_CENT,
            backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
            logType: 'WHOLE_FLOAT_ACCRUAL',
            referenceTimeMillis: refTime.valueOf()
        }; 
        
        Reflect.deleteProperty(floatBalanceAdjustment, 'amount');
        await expect(rds.addOrSubtractFloat(floatBalanceAdjustment)).to.be.rejectedWith('Invalid or missing value for property: amount');
        floatBalanceAdjustment.amount = Math.floor(1000 * 100 * 100 * Math.random());

        floatBalanceAdjustment.unit = 'INVALID_UNIT';
        await expect(rds.addOrSubtractFloat(floatBalanceAdjustment)).to.be.rejectedWith('Invalid float unit');
        floatBalanceAdjustment.unit = constants.floatUnits.HUNDREDTH_CENT;

        floatBalanceAdjustment.transactionType = 'INVALID_TRANSACTION_TYPE';
        await expect(rds.addOrSubtractFloat(floatBalanceAdjustment)).to.be.rejectedWith('Invalid transaction type');
        floatBalanceAdjustment.transactionType = constants.floatTransTypes.ACCRUAL;

        floatBalanceAdjustment.backingEntityType = 'INVALID_ENTITY_TYPE';
        await expect(rds.addOrSubtractFloat(floatBalanceAdjustment)).to.be.rejectedWith('Invalid backing entity type');

        expect(multiTableStub).to.have.not.been.called;
        expect(balanceStub).to.have.not.been.called;
    });

});


describe('Accrual happy paths', () => {

    const stubTransactionId = uuid();

    const testAccrualInstruction = {
        amount: common.testValueAccrualSize,
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        transactionType: constants.floatTransTypes.ACCRUAL,
        allocatedToType: constants.entityTypes.BONUS_POOL,
        allocatedToId: common.testValueBonusPoolTracker,
        relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
        relatedEntityId: 'mmkt_backing_trans_id',
        transactionId: stubTransactionId
    };

    const expectedQuery = common.allocationExpectedQuery(config.get('tables.floatTransactions')); 
    const expectedColumns = common.allocationExpectedColumns;
    
    const expectedValues = [{ 
        'transaction_id': stubTransactionId, 
        'client_id': common.testValidClientId, 
        'float_id': common.testValidFloatId, 
        't_type': constants.floatTransTypes.ACCRUAL,
        't_state': constants.floatTxStates.SETTLED,
        'amount': testAccrualInstruction.amount,
        'currency': testAccrualInstruction.currency, 
        'unit': testAccrualInstruction.unit, 
        'allocated_to_type': testAccrualInstruction.allocatedToType,
        'allocated_to_id': testAccrualInstruction.allocatedToId,
        'related_entity_type': testAccrualInstruction.relatedEntityType,
        'related_entity_id': testAccrualInstruction.relatedEntityId
    }];

    before(() => {
        insertStub.reset();
        insertStub.withArgs(expectedQuery, expectedColumns, expectedValues).resolves({rows: [{'transaction_id': stubTransactionId}]});
    });

    after(() => {
        resetStubs();
    });

    it('Inserts a float accrual correctly', async () => {
        // logger('Expected values: ', expectedValues);
        const allocationResult = await rds.allocateFloat(common.testValidClientId, common.testValidFloatId, [testAccrualInstruction]);
        logger('Finished allocation');
        expect(allocationResult).to.exist;
        expect(allocationResult).to.eql([{id: stubTransactionId}]);
        expect(insertStub).to.have.been.calledOnce;
        expect(insertStub).to.have.been.calledWith(expectedQuery, expectedColumns, expectedValues);
    });

    // it('Adjusts float balance correctly', async () => {
        
    // });
});

// todo : think & probe maths in here hard (rounding), including errors
describe('Company and bonus share allocations', () => {

    const bonusTxId = uuid();

    const testBonusAllocation = {
        label: 'BONUS',
        amount: Math.round(common.testValueAccrualSize * common.testValueBonusPoolShare),
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        allocatedToType: constants.entityTypes.BONUS_POOL,
        allocatedToId: common.testValueBonusPoolTracker,
        relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
        relatedEntityId: common.testValidAccrualId,
        transactionId: bonusTxId
    };

    const companyTxId = uuid();

    const testCompanyAllocation = {
        label: 'COMPANY',
        amount: Math.round(common.testValueAccrualSize * common.testValueCompanyShare),
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        allocatedToType: constants.entityTypes.COMPANY_SHARE,
        allocatedToId: common.testValueClientCompanyTracker,
        relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
        relatedEntityId: common.testValidAccrualId,
        transactionId: companyTxId
    };

    const expectedQuery = common.allocationExpectedQuery(config.get('tables.floatTransactions'));
    const expectedColumns = common.allocationExpectedColumns;

    const expectedValuesBonus = { 
        'transaction_id': bonusTxId, 
        'client_id': common.testValidClientId, 
        'float_id': common.testValidFloatId, 
        't_type': constants.floatTransTypes.ALLOCATION,
        't_state': constants.floatTxStates.SETTLED,
        'amount': testBonusAllocation.amount,
        'currency': testBonusAllocation.currency, 
        'unit': testBonusAllocation.unit, 
        'allocated_to_type': testBonusAllocation.allocatedToType,
        'allocated_to_id': testBonusAllocation.allocatedToId,
        'related_entity_type': testBonusAllocation.relatedEntityType,
        'related_entity_id': testBonusAllocation.relatedEntityId
    };

    const expectedValuesCompany = { 
        'transaction_id': companyTxId, 
        'client_id': common.testValidClientId, 
        'float_id': common.testValidFloatId, 
        't_type': constants.floatTransTypes.ALLOCATION,
        't_state': constants.floatTxStates.SETTLED,
        'amount': testCompanyAllocation.amount,
        'currency': testCompanyAllocation.currency, 
        'unit': testCompanyAllocation.unit, 
        'allocated_to_type': testCompanyAllocation.allocatedToType,
        'allocated_to_id': testCompanyAllocation.allocatedToId,
        'related_entity_type': testCompanyAllocation.relatedEntityType,
        'related_entity_id': testCompanyAllocation.relatedEntityId
    };

    before(() => {
        insertStub.withArgs(expectedQuery, expectedColumns, [expectedValuesBonus]).resolves({rows: [{'transaction_id': bonusTxId}]});
        insertStub.withArgs(expectedQuery, expectedColumns, [expectedValuesCompany]).resolves({rows: [{'transaction_id': companyTxId}]});
        insertStub.withArgs(expectedQuery, expectedColumns, [expectedValuesBonus, expectedValuesCompany]).
            resolves({rows: [{'transaction_id': bonusTxId}, {'transaction_id': companyTxId}]});
    });

    beforeEach(() => {
        insertStub.resetHistory();
    });

    after(() => {
        resetStubs();
    });

    it('Allocates the bonus pool correctly', async () => {
        // logger('Expecting values: ', expectedValuesBonus);
        const insertResult = await rds.allocateFloat(common.testValidClientId, common.testValidFloatId, [testBonusAllocation]);
        logger('Completed bonus allocation query, result: ', insertResult);
        expect(insertResult).to.exist;
        expect(insertResult).to.eql([{'BONUS': bonusTxId}]);
        expect(insertStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedColumns, [expectedValuesBonus]);
    });

    it('Allocates the client company share correctly', async () => {
        const insertResult = await rds.allocateFloat(common.testValidClientId, common.testValidFloatId, [testCompanyAllocation]);
        logger('Completed company allocation query');
        expect(insertResult).to.exist;
        expect(insertResult).to.eql([{'COMPANY': companyTxId}]);
        expect(insertStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedColumns, [expectedValuesCompany]);
    });

    it('Allocates them both at once correctly', async () => {
        const insertResult = await rds.allocateFloat(common.testValidClientId, common.testValidFloatId, [testBonusAllocation, testCompanyAllocation]);
        logger('Completed dual allocation');
        expect(insertResult).to.exist;
        expect(insertResult).to.eql([{'BONUS': bonusTxId}, {'COMPANY': companyTxId}]);
        expect(insertStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedColumns, [expectedValuesBonus, expectedValuesCompany]);
    });

});

describe('User account allocation', () => {

    after(() => {
        resetStubs();
    });

    const generateUids = (numberUsers) => Array(numberUsers).fill().map(() => uuid());
    const baseAllocationRequest = {
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        allocatedToType: constants.entityTypes.END_USER_ACCOUNT,
        relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
        relatedEntityId: common.testValidAccrualId
    };

    const generateUserAllocationRequests = (amountAllocations) => {
        const numberUsers = amountAllocations.length;
        const accountIds = generateUids(numberUsers);
        // logger('Base alloc request: ', baseAllocationRequest);
        const requests = amountAllocations.map((amount, idx) => {
            const newRequest = JSON.parse(JSON.stringify(baseAllocationRequest));
            newRequest.floatTxId = uuid();
            newRequest.accountTxId = uuid();
            newRequest.amount = amount;
            newRequest.accountId = accountIds[idx];
            return newRequest;
        });

        return requests;
    };

    const generateAllocations = (numberOfUsers, maxAllocation) => {
        const allocationAmounts = Array(numberOfUsers).fill().map(() => Math.round(Math.random() * maxAllocation));
        return generateUserAllocationRequests(allocationAmounts);
    };

    const baseFloatAllocationQueryDef = {
        query: common.allocationExpectedQuery(config.get('tables.floatTransactions')),
        columnTemplate: common.allocationExpectedColumns
    };

    const baseAccountAllocationQueryDef = {
        query: `insert into ${config.get('tables.accountTransactions')} (transaction_id, account_id, transaction_type, settlement_status, ` +
            `settlement_time, amount, currency, unit, float_id, client_id, float_alloc_tx_id, tags) values %L returning transaction_id, amount`,
        columnTemplate: '${transaction_id}, ${account_id}, ${transaction_type}, ${settlement_status}, ${settlement_time}, ' + 
            '${amount}, ${currency}, ${unit}, ${float_id}, ${client_id}, ${float_alloc_tx_id}, ${tags}'
    };

    it('Persists a large number of allocations correctly', async () => {
        const floatQueryDef = { ...baseFloatAllocationQueryDef };
        const allocRequests = generateAllocations(1, 100 * 100 * 100); // a hundred rand in hundredth cents (as daily interest, equals ind account of R1m roughly)
        
        floatQueryDef.rows = allocRequests.map((request) => ({
            'transaction_id': request.floatTxId,
            'client_id': common.testValidClientId,
            'float_id': common.testValidFloatId,
            't_type': constants.floatTransTypes.ALLOCATION,
            't_state': constants.floatTxStates.SETTLED,
            'amount': request.amount,
            'currency': request.currency,
            'unit': request.unit,
            'allocated_to_type': constants.entityTypes.END_USER_ACCOUNT,
            'allocated_to_id': request.accountId,
            'related_entity_type': constants.entityTypes.ACCRUAL_EVENT,
            'related_entity_id': common.testValidAccrualId
        }));

        const accountQueryDef = JSON.parse(JSON.stringify(baseAccountAllocationQueryDef));
        accountQueryDef.rows = allocRequests.map((request) => ({
            'transaction_id': request.accountTxId,
            'account_id': request.accountId,
            'transaction_type': 'FLOAT_ALLOCATION',
            'settlement_status': 'ACCRUED',
            'settlement_time': null,
            'amount': request.amount,
            'currency': request.currency,
            'unit': request.unit,
            'float_id': common.testValidFloatId,
            'client_id': common.testValidClientId,
            'float_alloc_tx_id': request.floatTxId,
            'tags': [`ACCRUAL_EVENT::${common.testValidAccrualId}`]
        }));

        const floatTxArray = allocRequests.map((request) => ({ 'transaction_id': request.floatTxId }));
        const accountTxArray = allocRequests.map((request) => ({ 'transaction_id': request.accountTxId, 'amount': request.amount }));

        multiTableStub.reset();
        multiTableStub.resolves([floatTxArray, accountTxArray]);

        const insertionResult = await rds.allocateToUsers(common.testValidClientId, common.testValidFloatId, allocRequests);
        
        const extractedFloatIds = allocRequests.map((request) => request.floatTxId);
        const extractAccountTxIds = allocRequests.map((request) => request.accountTxId);

        expect(insertionResult).to.exist;
        expect(insertionResult).to.eql({ result: 'SUCCESS', floatTxIds: extractedFloatIds, accountTxIds: extractAccountTxIds });
        expect(multiTableStub).to.be.calledOnceWithExactly([floatQueryDef, accountQueryDef]);
    });

    // it('Throws an error if passed account IDs that do not exist', () => {

    // });

    // it('Handles the absence of related entity id and type without error', () => {

    // });

});

describe('Test account summation and float balances', () => {

    const floatTable = config.get('tables.floatTransactions');
    const accountTable = config.get('tables.openAccounts');

    before(() => resetStubs());
    afterEach(() => resetStubs());

    // note : we are here assuming that any save has a corresponding add to float and allocation action
    // further note : this becomes unpredictable in timing when this approaches 10k, but seems due to generating objects
    // keep a close eye on it and do some further optimization in the future 
    it('Should accurately query for the list of accounts and their totals', async () => {
        const numberOfAccounts = 1000;
        const accountIds = Array(numberOfAccounts).fill().map(() => uuid());

        // using reduce and spread here, nicely explained in answer: https://stackoverflow.com/questions/42974735/create-object-from-array
        const wholeCentObject = accountIds.reduce((o, accountId) => ({ ...o, [accountId]: Math.round(Math.random() * 1000 * 100) }), {});
        const wholeCentRowResponse = accountIds.map((id) => ({ 'account_id': id, 'unit': constants.floatUnits.WHOLE_CENT, 'sum': wholeCentObject[id] }));
        
        const hundredthsObject = accountIds.reduce((o, accountId) => ({ ...o, [accountId]: Math.round(Math.random() * 1000 * 100 * 100) }), {});
        const hundredthsRowResponse = accountIds.map((id) => ({ 'account_id': id, 'unit': constants.floatUnits.HUNDREDTH_CENT, 'sum': hundredthsObject[id] }));

        const consolidatedRows = wholeCentRowResponse.concat(hundredthsRowResponse);

        const expectedSumObject = new Map();
        accountIds.forEach((accountId) => {
            expectedSumObject.set(accountId, ((wholeCentObject[accountId] * constants.floatUnitTransforms.WHOLE_CENT) +
                (hundredthsObject[accountId] * constants.floatUnitTransforms.HUNDREDTH_CENT)));
        });

        // NB : todo : filter on transaction_type (i.e., accruals vs others)
        const sumQuery = `select account_id, unit, sum(amount) from ${floatTable} inner join ${accountTable} ` +
            `on ${floatTable}.allocated_to_id = ${accountTable}.account_id::varchar ` + 
            `where float_id = $1 and currency = $2 and allocated_to_type = $3 group by account_id, unit`;
        const valuesArray = [common.testValidFloatId, 'ZAR', constants.entityTypes.END_USER_ACCOUNT];

        queryStub.withArgs(sumQuery, valuesArray).resolves(consolidatedRows);
        
        logger('Completed setup, calling main method');
        const accountQueryResult = await rds.obtainAllAccountsWithPriorAllocations(common.testValidFloatId, 'ZAR', constants.entityTypes.END_USER_ACCOUNT);
        logger('Finished main method');

        expect(accountQueryResult).to.exist;
        expect(accountQueryResult).to.be.a('Map');
        expect(accountQueryResult.size).to.equal(numberOfAccounts);
        logger('Completed expectation checks, calling deep equal');
        expect(accountQueryResult).to.deep.equal(expectedSumObject);
        logger('Finished deep equal check');

        expect(queryStub).to.have.been.callCount(1);
        expect(queryStub).to.have.been.calledWithExactly(sumQuery, valuesArray);
        expect(insertStub).to.not.have.been.called;
        expect(multiTableStub).to.not.have.been.called;
    }).timeout('3000');

    it('Should handle case where no accounts found for float', async () => {
        const sumQuery = `select account_id, unit, sum(amount) from ${floatTable} inner join ${accountTable} ` +
            `on ${floatTable}.allocated_to_id = ${accountTable}.account_id::varchar ` + 
            `where float_id = $1 and currency = $2 and allocated_to_type = $3 group by account_id, unit`;

        queryStub.withArgs(sumQuery, ['bad_float', 'USD', constants.entityTypes.END_USER_ACCOUNT]).returns([]);
        const queryResult = await rds.obtainAllAccountsWithPriorAllocations('bad_float', 'USD', constants.entityTypes.END_USER_ACCOUNT);
        logger('Result: ', queryResult);
        expect(queryResult).to.exist;
        expect(queryResult).to.deep.equal(new Map());
    });

    it('Should accurately retrieve current float balances', async () => {
        // const numberOfAccounts = 1;
        // const accountIds = Array(numberOfAccounts).fill().map(() => uuid());

        const generateTransactions = (numberOfTxs, unit, baseAmount, tTypes) => Array(numberOfTxs).fill().map(() => ({
            'transaction_id': uuid(), 
            'unit': unit,
            'currency': 'ZAR',
            'amount': Math.round(Math.random() * baseAmount),
            'transaction_type': tTypes[Math.floor(Math.random() * tTypes.length)]
        }));
        
        const numberOfPositiveTxs = 1000;
        const positiveTxTypes = [constants.floatTransTypes.ACCRUAL, constants.floatTransTypes.CAPITALIZATION, 
            constants.floatTransTypes.DEPOSIT];
        const positiveTxRows = generateTransactions(numberOfPositiveTxs, constants.floatUnits.HUNDREDTH_CENT,
            1000 * 100 * 100, positiveTxTypes);
        const positiveRowSum = positiveTxRows.map((row) => row.amount).reduce((cum, value) => cum + value, 0);
        // logger('Positive rows: ', positiveTxRows);

        const numberOfNegativeTxs = 1500;
        const negativeTxTypes = [constants.floatTransTypes.WITHDRAWAL];
        const negativeTxRows = generateTransactions(numberOfNegativeTxs, constants.floatUnits.WHOLE_CENT,
            -1000 * 100, negativeTxTypes);
        const negativeRowSum = negativeTxRows.map((row) => row.amount).reduce((cum, value) => cum + value, 0);
        // logger('Negative rows: ', negativeTxRows);
        
        const unitQuery = `select distinct(unit) from ${floatTable} where float_id = $1 and currency = $2 and allocated_to_type = $3 and t_state = $4`;
        const unitColumns = [common.testValidFloatId, 'ZAR', constants.entityTypes.FLOAT_ITSELF, 'SETTLED'];

        queryStub.withArgs(unitQuery, sinon.match(unitColumns)).resolves([{ unit: constants.floatUnits.HUNDREDTH_CENT}, { unit: constants.floatUnits.WHOLE_CENT }]);
        
        const sumQuery = `select unit, sum(amount) from ${floatTable} where float_id = $1 and currency = $2 and unit = $3 and ` +
            `allocated_to_type = $4 and t_state = $5 and creation_time between $6 and $7 group by unit`;
        const startOfTime = new Date(0);
        // const currentTime = new Date(); // not used, given matcher below, with rationale
        
        // use any date matcher on last param, as 'now' has ticked on a few millis, and alternate prevents testing of defaults
        const sumParams = (unit) => [common.testValidFloatId, 'ZAR', unit, constants.entityTypes.FLOAT_ITSELF, 'SETTLED', startOfTime, sinon.match.date];
        queryStub.withArgs(sumQuery, sinon.match(sumParams(constants.floatUnits.HUNDREDTH_CENT))).
            returns(Promise.resolve([{ 'unit': constants.floatUnits.HUNDREDTH_CENT, 'sum': positiveRowSum }]));
        queryStub.withArgs(sumQuery, sinon.match(sumParams(constants.floatUnits.WHOLE_CENT))).
            returns(Promise.resolve([{ 'unit': constants.floatUnits.WHOLE_CENT, 'sum': negativeRowSum }]));

        const mostCommonUnitQuery = `select unit, count(*) from ${floatTable} group by unit`;
        queryStub.withArgs(mostCommonUnitQuery, []).resolves([
            { 'unit': constants.floatUnits.HUNDREDTH_CENT, 'count(*)': numberOfPositiveTxs }, 
            { 'unit': constants.floatUnits.WHOLE_CENT, 'count(*)': numberOfNegativeTxs }]);

        const mockEarliestTx = { 'transaction_id': uuid(), 'amount': positiveTxRows[0].amount };
        const earliestTxQuery = `select transaction_id, amount, currency, unit, related_entity_type, related_entity_id ` +
            `from ${floatTable} where float_id = $1 and currency = $2 and creation_time > $3 order by creation_time asc limit 1`;
        const earliestTxParams = [common.testValidFloatId, 'ZAR', startOfTime];
        queryStub.withArgs(earliestTxQuery, sinon.match(earliestTxParams)).resolves([mockEarliestTx]);

        const mockLatestTx = { 'transaction_id': uuid(), 'amount': positiveTxRows[numberOfPositiveTxs - 1].amount };
        const mostRecentTxQuery = `select transaction_id, amount, currency, unit, related_entity_type, related_entity_id ` +
            `from ${floatTable} where float_id = $1 and currency = $2 and creation_time < $3 order by creation_time desc limit 1`;
        const mostRecentTxParams = [common.testValidFloatId, 'ZAR', sinon.match.date];
        queryStub.withArgs(mostRecentTxQuery, sinon.match(mostRecentTxParams)).resolves([mockLatestTx]);
 
        const expectedBalance = (positiveRowSum * constants.floatUnitTransforms.HUNDREDTH_CENT) + (negativeRowSum * constants.floatUnitTransforms.WHOLE_CENT);
        logger(`Positive sum ${positiveRowSum} in hundredth cent, and ${negativeRowSum} in whole cents, for exp balance ${expectedBalance}`);

        const floatBalance = await rds.calculateFloatBalance(common.testValidFloatId, 'ZAR');
        
        expect(floatBalance).to.exist;
        expect(floatBalance).to.deep.equal({ 
            balance: expectedBalance, 
            unit: constants.floatUnits.HUNDREDTH_CENT, // slightly redundant with most common unit but may want flexibility to define in future
            earliestTx: mockEarliestTx, 
            latestTx: mockLatestTx, 
            mostCommonUnit: constants.floatUnits.HUNDREDTH_CENT
        });
        
        expect(queryStub).to.have.been.calledWith(unitQuery, sinon.match(unitColumns));
        expect(queryStub).to.have.been.calledWith(sumQuery, sinon.match(sumParams(constants.floatUnits.HUNDREDTH_CENT)));
        expect(queryStub).to.have.been.calledWith(sumQuery, sinon.match(sumParams(constants.floatUnits.WHOLE_CENT)));
        expect(queryStub).to.have.been.calledWith(mostCommonUnitQuery, []);
        expect(queryStub).to.have.been.calledWith(earliestTxQuery, sinon.match(earliestTxParams));
        expect(queryStub).to.have.been.calledWith(mostRecentTxQuery, sinon.match(mostRecentTxParams));
        expect(queryStub).to.have.been.callCount(6);
    });

    // todo: test for blanks on each kind of result
    // it('Returns blanks if no results on queries', () => {

    // });

});
