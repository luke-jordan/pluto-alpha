'use strict';

const logger = require('debug')('jupiter:capitalization:rds-test');
const moment = require('moment');
const uuid = require('uuid/v4');

const camelizeKeys = require('camelize-keys');

const helper = require('./test.helper');
const constants = require('../constants');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');

const queryStub = sinon.stub();
const updateStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.updateRecord = updateStub;
    }
}

const rds = proxyquire('../persistence/rds', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const testFloatId = 'some-mmkt-float';
const testClientId = 'this-client-here';

describe('*** FETCH LAST LOG ***', () => {

    beforeEach(() => helper.resetStubs(queryStub));

    const mockEndTime = moment().subtract(1, 'day').startOf('day');

    it('Happy path, retrieves and transforms appropriately', async () => {
        const expectedQuery = 'select * from float_data.float_log where log_type = $1 and float_id = $2 and client_id = $3 and ' +
            'reference_time < $4 order by reference_time desc limit 1';
        const expectedValues = ['CAPITALIZATION_EVENT', testFloatId, testClientId, mockEndTime.format()];

        const mockLogTime = moment().subtract(1, 'week');
        const mockLog = { 'client_id': testClientId, 'float_id': testFloatId, 'creation_time': mockLogTime.format(), 'reference_time': mockLogTime.format(), 'log_type': 'CAPITALIZATION_EVENT' };
        queryStub.resolves([mockLog]);

        const resultOfRetrieval = await rds.fetchLastLog({ clientId: testClientId, floatId: testFloatId, endTime: mockEndTime, logType: 'CAPITALIZATION_EVENT' });
        
        const expectedLog = { ...camelizeKeys(mockLog), creationTime: moment(mockLogTime.format()), referenceTime: moment(mockLogTime.format()) };
        expect(resultOfRetrieval).to.deep.equal(expectedLog);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

    it('Returns null if nothing found', async () => {
        const expectedQuery = 'select * from float_data.float_log where log_type = $1 and float_id = $2 and client_id = $3 and ' +
            'reference_time < $4 order by reference_time desc limit 1';
        const expectedValues = ['CAPITALIZATION_EVENT', testFloatId, testClientId, mockEndTime.format()];

        queryStub.resolves([]);
        const resultOfRetrieval = await rds.fetchLastLog({ clientId: testClientId, floatId: testFloatId, endTime: mockEndTime, logType: 'CAPITALIZATION_EVENT' });
        expect(resultOfRetrieval).to.be.null;

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

});

describe('*** FETCH PRIOR ACCRUALS ****', () => {

    const mockStartTime = moment().subtract(1, 'month').startOf('day');
    const mockEndTime = moment().subtract(1, 'day').startOf('day');

    const mockBonusPoolId = 'this-is-a-bonus-pool';
    const mockClientShare = 'this-is-a-client-share';

    beforeEach(() => helper.resetStubs(queryStub));

    const generateRowsForAccountId = (entityId, baseAmount = 100, entityType = 'END_USER_ACCOUNT') => Array(helper.randomInteger(3) + 1).
        fill().map(() => ({
            'allocated_to_id': entityId,
            'allocated_to_type': entityType,
            'unit': Object.values(constants.floatUnits)[helper.randomInteger(3)],
            'sum': String(helper.randomInteger(baseAmount))
        }));
    
    const generateAccountBalanceRows = (accountId, baseAmount = 1000) => {
        const ownerId = uuid();
        const humanRef = `CDOE${helper.randomInteger(1000)}`;
        return Array(helper.randomInteger(3) + 1).fill().map(() => ({
            'account_id': accountId,
            'owner_user_id': ownerId,
            'human_ref': humanRef,
            'unit': Object.values(constants.floatUnits)[helper.randomInteger(3)],
            'sum': String(helper.randomInteger(baseAmount))
        }));
    };

    const sumAmountsForEntity = (entityId, rows, entityKey = 'allocated_to_id') => rows.filter((row) => row[entityKey] === entityId).
        reduce((sum, row) => sum + (row['sum'] * constants.floatUnitTransforms[row['unit']]), 0);

    it('Happy path, retrieves, and compiles map, appropriately', async () => {
        const testNumberAccounts = 200;

        const mockArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            unit: 'HUNDREDTH_CENT',
            currency: 'USD',
            startTime: mockStartTime,
            endTime: mockEndTime
        };

        // first we get the accrual entries, that are either settled or pending (ie not expired or superceded)
        const expectedMainQuery = `select allocated_to_id, allocated_to_type, unit, sum(amount) from float_data.float_transaction_ledger ` +
            `where client_id = $1 and float_id = $2 and creation_time > $3 and creation_time < $4 ` +
            `and t_type = $5 and t_state in ($6, $7) and currency = $8 and allocated_to_type != $9 ` +
            `group by allocated_to_id, allocated_to_type, unit`;
        const expectedValues = [testClientId, testFloatId, mockStartTime.format(), mockEndTime.format(), 
            'ACCRUAL', 'SETTLED', 'PENDING', 'USD', 'FLOAT_ITSELF'];

        // then for the accounts, we get the prior balances, human references, etc. -- worth the extra query
        const expectedAccountQuery = `select account_id, owner_user_id, human_ref, unit, sum(amount) from ` +
            `float_data.float_transaction_ledger as float_tx inner join account_data.core_account_ledger as account_info on ` +
            `allocated_to_id = account_id::text where float_tx.client_id = $1 and ` +
            `float_tx.float_id = $2 and float_tx.creation_time < $3 and float_tx.t_state = $4 ` +
            `and float_tx.t_type != $5 and float_tx.currency = $6 group by account_id, owner_user_id, human_ref, unit`;
        const accountValues = [testClientId, testFloatId, mockEndTime.format(), 'SETTLED', 'ACCRUAL', 'USD'];
        
        const generatedAccountIds = Array(testNumberAccounts).fill().map(() => uuid());
        const generatedRows = generatedAccountIds.map((accountId) => generateRowsForAccountId(accountId, 100)).
            reduce((cum, rows) => [...cum, ...rows], []);
        generatedRows.push(...generateRowsForAccountId(mockBonusPoolId, 10, 'BONUS_POOL'));
        generatedRows.push(...generateRowsForAccountId(mockClientShare, 10, 'COMPANY_SHARE'));
        // logger('Generated rows: ', generatedRows);

        const generatedAccountRows = generatedAccountIds.map((accountId) => generateAccountBalanceRows(accountId, 1000)).
            reduce((cum, rows) => [...cum, ...rows], []);
        // logger('Generated account rows: ', generatedAccountRows);

        const mapOfAccrualSums = new Map(generatedAccountIds.map((accountId) => [accountId, sumAmountsForEntity(accountId, generatedRows)]));
        mapOfAccrualSums.set(mockBonusPoolId, sumAmountsForEntity(mockBonusPoolId, generatedRows));
        mapOfAccrualSums.set(mockClientShare, sumAmountsForEntity(mockClientShare, generatedRows));
        // logger('Created map of sums: ', mapOfAccrualSums);

        const mapOfBalances = new Map(generatedAccountIds.map((accountId) => [accountId, sumAmountsForEntity(accountId, generatedAccountRows, 'account_id')]));
        // logger('And map of balance sums: ', mapOfBalances);

        const entityIds = [...generatedAccountIds, mockBonusPoolId, mockClientShare];
        const expectedFullMap = new Map(entityIds.map((entityId) => {
            let assembledEntity = {};
            if (entityId === mockBonusPoolId || entityId === mockClientShare) {
                assembledEntity = {
                    entityId,
                    entityType: entityId === mockBonusPoolId ? 'BONUS_POOL' : 'COMPANY_SHARE',
                    unit: 'HUNDREDTH_CENT',
                    currency: 'USD',
                    amountAccrued: mapOfAccrualSums.get(entityId)
                };
            } else {
                const accountRow = generatedAccountRows.find((row) => row['account_id'] === entityId);
                assembledEntity = {
                    entityId, // redundant with account ID, but handy to have both keys present for consumer
                    entityType: 'END_USER_ACCOUNT',
                    accountId: entityId,
                    ownerUserId: accountRow['owner_user_id'],
                    humanRef: accountRow['human_ref'],
                    unit: 'HUNDREDTH_CENT',
                    currency: 'USD',
                    amountAccrued: mapOfAccrualSums.get(entityId), 
                    priorSettledBalance: mapOfBalances.get(entityId)            
                };
            }
            return [entityId, assembledEntity];
        }));

        // logger('And full map: ', expectedFullMap);

        queryStub.withArgs(expectedMainQuery, expectedValues).resolves(generatedRows);
        queryStub.withArgs(expectedAccountQuery, accountValues).resolves(generatedAccountRows);

        const resultOfQuery = await rds.fetchAccrualsInPeriod(mockArgs);
        // logger('Resulting map: ', resultOfQuery);

        expect(resultOfQuery).to.exist;
        expect(resultOfQuery).to.be.a('map');

        // leaving this here as expect deep equal's output is less than helpful when debugging a mismatch
        // expect(resultOfQuery.keys()).to.deep.equal(expectedFullMap.keys());
        // Array.from(resultOfQuery.keys()).forEach((key) => {
        //     logger('Testing key: ', key);
        //     expect(resultOfQuery.get(key)).to.deep.equal(expectedFullMap.get(key));
        // });

        logger('Testing map equivalence ...');
        expect(resultOfQuery).to.deep.equal(expectedFullMap);

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(expectedMainQuery, expectedValues);
        expect(queryStub).to.have.been.calledWithExactly(expectedAccountQuery, accountValues);
    });

});

describe('*** SUPERCEDE PRIOR ACCRUALS ***', () => {

    const mockStartTime = moment().subtract(1, 'month').startOf('day');
    const mockEndTime = moment().subtract(1, 'day').startOf('day');

    beforeEach(() => helper.resetStubs(queryStub));

    it('Formulates supercession update properly, and executes', async () => {
        const expectedArgs = { 
            startTime: mockStartTime,
            endTime: mockEndTime,
            clientId: testClientId, 
            floatId: testFloatId, 
            currency: 'USD' 
        };

        // since rows remain, this is always reversible, and comes at the end, plus is pretty tightly defined, so 
        // instead of selecting, modifying, and doing a big update one by one, we do it all at once, first in float,
        // then in account

        const expectedFloatQuery = `update float_data.float_transaction_ledger set t_state = $1 where ` +
            `client_id = $2 and float_id = $3 and t_type = $4 and currency = $5 and creation_time between $6 and $7 ` +
            `returning updated_time`;

        const expectedAccQuery = `update transaction_data.core_transaction_ledger set settlement_status = $1 where ` +
            `client_id = $2 and float_id = $3 and transaction_type = $4 and currency = $5 and creation_time between $6 and $7 ` +
            `returning updated_time`;

        const values = ['SUPERCEDED', testClientId, testFloatId, 'ACCRUAL', 'USD', mockStartTime.format(), mockEndTime.format()];

        // todo : need some way to put these in a TX
        updateStub.withArgs(expectedFloatQuery, values).resolves({ rows: [{ 'updated_time': moment().format() }] });
        updateStub.withArgs(expectedAccQuery, values).resolves({ rows: [{ 'updated_time': moment().format() }] });

        const resultOfSupercession = await rds.supercedeAccruals(expectedArgs);

        expect(resultOfSupercession).to.deep.equal({ result: 'SUCCESS', floatRowsUpdated: 1, accountRowsUpdated: 1 });
        expect(updateStub).to.have.been.calledTwice;
        expect(updateStub).to.have.been.calledWithExactly(expectedFloatQuery, values);
        expect(updateStub).to.have.been.calledWithExactly(expectedAccQuery, values);

    });

    // it('Rejects calls without the write params', async () => {

    // });
});
