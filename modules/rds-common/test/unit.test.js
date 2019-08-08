'use strict';

const { QueryError, CommitError, NoValuesError } = require('../errors');

const logger = require('debug')('jupiter:rds-common:unit-test');
const config = require('config');

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const chaiAsPromised = require('chai-as-promised');

const expect = chai.expect;

const proxyquire = require('proxyquire');

const queryStub = sinon.stub();
const releaseStub = sinon.stub();
const connectStub = sinon.stub().resolves({ 
    query: queryStub,
    release: releaseStub
});

const endStub = sinon.stub();

chai.use(sinonChai);
chai.use(chaiAsPromised);

class MockPostgres {
    constructor () {
        this.connect = connectStub;
        this.query = queryStub;
        this.end = endStub;
    }
}

const clearStubHistory = () => {
    connectStub.resetHistory();
    queryStub.resetHistory();
    releaseStub.resetHistory();
    endStub.resetHistory();
};

const RdsConnection = proxyquire('../index', {
    'pg': { Pool: MockPostgres },
    '@noCallThru': true
});

const expectTxWrapping = (expectedTxEnd) => {
    expect(queryStub).to.have.been.calledWithExactly('BEGIN');
    expect(queryStub).to.have.been.calledWithExactly(expectedTxEnd);
};

const expectQuery = (query, values) => {
    // use strict comparison here because while selects can take [] (and require it), inserts are safely preformatted then passed without values
    if (values === null) {
        expect(queryStub).to.have.been.calledWithExactly(query);
    } else {
        expect(queryStub).to.have.been.calledWithExactly(query, values);
    }
};

const standardExpectations = (query, values, readOnly, skipTxWrapper, expectedTxEnd) => {
    expect(connectStub).to.have.been.calledOnce;
    expect(queryStub).to.have.been.calledWithExactly(readOnly ? 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY' : 'SET TRANSACTION READ WRITE');
    expectQuery(query, values);

    if (!skipTxWrapper) {
        expectTxWrapping(expectedTxEnd);    
    }

    const queryCalls = skipTxWrapper ? 2 : 4;
    expect(queryStub).to.have.been.callCount(queryCalls);
    expect(releaseStub).to.have.been.calledOnce; 
};

describe('Basic query pass through', () => {

    let rdsClient = { };

    const select1result = { command: 'SELECT', rowCount: 1, rows: [{'?column?': 1 }]};

    before(() => {
        queryStub.withArgs('SELECT 1').returns(select1result);
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });

    afterEach(() => {
        clearStubHistory();
    });

    after(() => {
        queryStub.reset();
    });
    
    it('Executes a test query properly', async () => {
        const queryResult = await rdsClient.testPool();
        expect(queryResult).to.exist;
        expect(queryResult).to.eql(select1result.rows);
        expect(queryStub).to.have.been.calledOnceWithExactly('SELECT 1');
    });

    it('Terminates pool and connections when asked', async () => {
        await rdsClient.endPool();
        expect(endStub).to.have.been.calledOnceWithExactly();
    });

    it('Runs a selection query properly', async () => {
        const selectQuery = 'SELECT (id, column_1) FROM table WHERE column_4 = $1 and column_5 = $2';
        const selectValues = ['value_1', 'value_2'];
        const result = { command: 'SELECT', rowCount: 2, rows: [{'id': 2, 'column_1': 'apples'}, {'id': 3, 'column_1': 'oranges'}]};
        queryStub.withArgs(selectQuery, selectValues).resolves(result);

        const rowResult = await rdsClient.selectQuery(selectQuery, selectValues);
        expect(rowResult).to.exist;
        expect(rowResult).to.eql(result.rows);
        // use integration tests to make sure these are in right order (ie will fail if not) - and/or find single spy - multi call order checking in Sinon
        standardExpectations(selectQuery, selectValues, true, true);
    });

    it('Runs an update query properly', async () => {
        const updateQuery = 'UPDATE table SET column_1 = $1 WHERE id = $2';
        const updateValues = [1500, 1];
        const result = { command: 'UPDATE' };
        queryStub.withArgs(updateQuery, updateValues).resolves(result);

        const updateResult = await rdsClient.updateRecord(updateQuery, updateValues);
        logger('Update result ? : ', updateResult);
        expect(updateResult).to.exist;
        expect(updateResult).to.eql(result);
        // as above, on ordering; also that default client connection state should be read only
        standardExpectations(updateQuery, updateValues, false, false, 'COMMIT');
    });

    it('Processes a deletion query properly', async () => {
        const tableName = 'schema1.table1';
        const conditionColumns = ['column_1', 'column_2'];
        const conditionValues = ['value1', 'value2'];

        const expectedDeleteQuery = 'DELETE FROM schema1.table1 WHERE (column_1 = $1) AND (column_2 = $2)';
        const expectedDeleteValues = conditionValues;
        queryStub.withArgs(expectedDeleteQuery, expectedDeleteValues).resolves({ command: 'DELETE' });

        const deleteResult = await rdsClient.deleteRow(tableName, conditionColumns, conditionValues);
        
        expect(deleteResult).to.exist;
        standardExpectations(expectedDeleteQuery, expectedDeleteValues, false, false, 'COMMIT');
    });

});

describe('*** UNIT TEST BULK ROW INSERTION ***', () => {

    let rdsClient = { };
    before(() => {
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });

    beforeEach(() => {
        clearStubHistory();
    });

    it('Assembles row insertion properly', async () => {
        const queryTemplate = 'INSERT INTO some_schema.some_table (column_1, column_2) VALUES %L returning insertion_id';
        const columnTemplate = '${column1}, ${column2}';
        const queryValues = [{ column1: 'Hello', column2: 'World' }, { column1: 'Something', column2: 'Else' }];

        const expectedValue = '(\'Hello\', \'World\'), (\'Something\', \'Else\')';
        const expectedQuery = `INSERT INTO some_schema.some_table (column_1, column_2) VALUES ${expectedValue} returning insertion_id`;

        const expectedResult = { rows: [{'insertion_id': 1 }, { 'insertion_id': 2 }]};
        queryStub.withArgs(expectedQuery).returns(expectedResult);

        const insertResult = await rdsClient.insertRecords(queryTemplate, columnTemplate, queryValues);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal(expectedResult);
        
        standardExpectations(expectedQuery, null, false, false, 'COMMIT');
    });

    it('Sanitizes values properly to prevent injection', async () => {
        const queryTemplate = 'INSERT INTO some_scema.some_table (column_1, column_2) VALUES %L';
        const columnTemplate = '${column1}, ${column2}';
        const maliciousValue = [{ column1: 'Watch this', column2: `'End'); DROP TABLE Users`}];

        const expectedSanitized = `INSERT INTO some_scema.some_table (column_1, column_2) VALUES ('Watch this', '''End''); DROP TABLE Users')`;

        queryStub.withArgs(expectedSanitized).throws('Well that should really trigger an insert error, but worst case some strange values');

        await expect(rdsClient.insertRecords(queryTemplate, columnTemplate, maliciousValue)).to.be.rejected.and.eventually.be.a('CommitError');
        standardExpectations(expectedSanitized, null, false, false, 'ROLLBACK');
    });

    it('Processes multi-insert queries properly', async () => {
        const queryTemplate1 = 'INSERT INTO schema1.table1 (column_1, column_2) VALUES %L RETURNING insertion_id';
        const queryColumns1 = '${column1}, ${column2}';
        const queryValues1 = [{ column1: 'Hello', column2: 'X' }, { column1: 'What', column2: 'Y' }];
        const queryDef1 = { query: queryTemplate1, columnTemplate: queryColumns1, rows: queryValues1 };
        const expectedQuery1 = `INSERT INTO schema1.table1 (column_1, column_2) VALUES ('Hello', 'X'), ('What', 'Y') RETURNING insertion_id`;
        
        const queryTemplate2 = 'INSERT INTO schema2.table1 (column_1, column_2, column_3) VALUES %L RETURNING insertion_id';
        const queryColumns2 = `${queryColumns1}, *{CONSTANT_HERE}`;
        const queryValues2 = [{ column1: 'Other', column2: 'Thing' }, { column1: 'Hey', column2: 'Over'}];
        const queryDef2 = { query: queryTemplate2, columnTemplate: queryColumns2, rows: queryValues2 };
        const expectedQuery2 = `INSERT INTO schema2.table1 (column_1, column_2, column_3) VALUES ('Other', 'Thing', 'CONSTANT_HERE'), ('Hey', 'Over', 'CONSTANT_HERE') RETURNING insertion_id`;

        queryStub.withArgs(expectedQuery1).resolves({ rows: [{ 'insertion_id': 1 }, { 'insertion_id': 2 }]});
        queryStub.withArgs(expectedQuery2).resolves({ rows: [{ 'insertion_id': 401 }, { 'insertion_id': 402 }]});

        const insertResult = await rdsClient.largeMultiTableInsert([queryDef1, queryDef2]);
        logger('Result of query: ', insertResult);

        expect(insertResult).to.exist;

        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledWithExactly(expectedQuery1);
        expect(queryStub).to.have.been.calledWithExactly(expectedQuery2);
        expect(queryStub).to.have.been.calledWithExactly('COMMIT');
        expect(releaseStub).to.have.been.calledOnce;
    });

});

describe('*** UNIT TEST MULTI-TABLE UPDATE AND INSERT ***', () => {

    let rdsClient = { };
    before(() => { 
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });
    beforeEach(() => clearStubHistory());

    it('Combined update and insert assembles as necessary', async () => {
        const testTime = new Date();

        const updateQueryKeyObject = { someId: 101, someTime: testTime };
        const updateQueryValueObject = { someStatus: 'SETTLED', someText: 'something_else', someBoolean: false };
        const updateDef = { table: 'schema1.tableX', key: updateQueryKeyObject, value: updateQueryValueObject, returnClause: 'updated_time' };

        const expectedUpdateQuery = 'UPDATE schema1.tableX SET some_status = $3, some_text = $4, some_boolean = $5 WHERE some_id = $1 and some_time = $2 RETURNING updated_time';
        const updateValues = [101, testTime, 'SETTLED', 'something_else', false];

        const insertQueryTemplate = 'INSERT INTO schema2.table1 (column_1, column_2) VALUES %L RETURNING insertion_id';
        const insertQueryColumns = '${column1}, ${column2}';
        const insertQueryValues = [{ column1: 'Hello', column2: 'X' }, { column1: 'What', column2: 'Y' }];
        const insertDef = { query: insertQueryTemplate, columnTemplate: insertQueryColumns, rows: insertQueryValues };
        
        const expectedInsertQuery = `INSERT INTO schema2.table1 (column_1, column_2) VALUES ('Hello', 'X'), ('What', 'Y') RETURNING insertion_id`;
        
        queryStub.withArgs(expectedUpdateQuery, sinon.match(updateValues)).resolves({ command: 'UPDATE', rows: [{ 'updated_time': new Date() }]});
        queryStub.withArgs(expectedInsertQuery).resolves({ rows: [{ 'insertion_id': 1 }, { 'insertion_id': 2 }]});

        const updateInsertResult = await rdsClient.multiTableUpdateAndInsert([updateDef], [insertDef]);
        logger('Result of queries: ', updateInsertResult);

        expect(updateInsertResult).to.exist;

        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledWithExactly(expectedUpdateQuery, sinon.match(updateValues));
        expect(queryStub).to.have.been.calledWithExactly(expectedInsertQuery);
        expect(queryStub).to.have.been.calledWithExactly('COMMIT');
        expect(releaseStub).to.have.been.calledOnce;
    });

});

describe('*** UNIT TEST BASIC POOL MGMT ***', () => {
    
    let rdsClient = { };

    before(() => {
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });

    afterEach(() => {
        clearStubHistory();
    });

    it('Calling end pool drains it', async () => {
        await rdsClient.endPool();
        expect(endStub).to.have.been.calledOnce;
    });

});

describe('Error handling, including connection release, non-parameterized queries, pool exhausted, etc', () => {

    let rdsClient = { };

    before(() => {
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });

    beforeEach(() => {
        connectStub.resetHistory();
        queryStub.reset();
        releaseStub.resetHistory();
    });

    after(() => {
        connectStub.reset();
        queryStub.reset();
        releaseStub.reset();
    });

    it('Error classes function as required', () => {
        const queryError = new QueryError('SELECT monstrous query', ['lousy_value']);
        expect(queryError.data.template).to.equal('SELECT monstrous query');
        expect(queryError.data.values).to.eql(['lousy_value']);

        const commitError = new CommitError('INSERT CONFLICTING THING', [{ id: 'conflicting_id' }]);
        expect(commitError.data.template).to.equal('INSERT CONFLICTING THING');
        expect(commitError.data.values).to.eql([{ id: 'conflicting_id' }]);

        const noValuesError = new NoValuesError('SELECT 1');
        expect(noValuesError.data.template).to.equal('SELECT 1'); 
    });

    it('Connection release is called if selection query fails', async () => {
        const badSelectionQuery = 'SELECT bad syntax who knows what this person is doing';
        queryStub.withArgs(badSelectionQuery, []).throws('Commit error');
        
        // note: deeper checks on error class etc., are failing on JS equality badness, so doing this as equivalent
        const expectedMsg = `Query with template ${badSelectionQuery} and values ${JSON.stringify([])} caused an error.`;
        await expect(rdsClient.selectQuery(badSelectionQuery, [])).to.be.rejected.
            and.to.eventually.have.property('message', expectedMsg);
        standardExpectations(badSelectionQuery, [], 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', true);
    });

    it('Update transaction calls rollback and release if commit fails', async () => {
        const badUpdateQuery = 'UPDATE THINGS INTO bad syntax who knows what this person is doing';
        const mockValues = [1500, 1];
        queryStub.withArgs(badUpdateQuery, mockValues).throws('Bad query'); // as above

        await expect(rdsClient.updateRecord(badUpdateQuery, mockValues)).to.be.rejected.
            and.to.eventually.be.a('CommitError');
        standardExpectations(badUpdateQuery, mockValues, false, false, 'ROLLBACK');
    });

    it('Insert calls throw error if badly templated', async () => {
        const badQuery = 'INSERT WITHOUT VALUE';
        const fineQuery = 'INSERT STUFF BADLY BUT HAS %L'
        const badColumns = '_something_';
        const fineColumns = '${someKey}';
        const badValues = [];

        await expect(rdsClient.insertRecords(badQuery, badColumns, badValues)).to.be.rejected.and.to.eventually.be.a('QueryError');
        await expect(rdsClient.insertRecords(fineQuery, badColumns, badValues)).to.be.rejected.and.to.eventually.be.a('QueryError');
        await expect(rdsClient.insertRecords(fineQuery, fineColumns, badValues)).to.be.rejected.and.to.eventually.be.a('QueryError');
        expect(connectStub).to.not.have.been.called;
    });

    it('Multitable update and insert throws error if no update', async () => {
        const fineInsertDef = { query: 'insert into schema (column) values %L', columnTemplate: '${column}', rows: [ {column: 'hello world'}]};
        await expect(rdsClient.multiTableUpdateAndInsert([], [fineInsertDef])).to.be.rejected.and.to.eventually.be.a('NoValuesError');
    });

    it('Insert calls rollback and release if commit fails', async () => {
        const badInsertQuery = 'INSERT STUFF BADLY IN FALSE WAYS %L';
        const badColumn = '${column1}';
        const badValues = [{ column1: 123 }];
        const formattedQuery = `INSERT STUFF BADLY IN FALSE WAYS ('123')`;

        queryStub.withArgs(formattedQuery).throws('Insertion error');

        await expect(rdsClient.insertRecords(badInsertQuery, badColumn, badValues)).to.be.rejected.
            and.to.eventually.be.a('CommitError');

        standardExpectations(formattedQuery, null, false, false, 'ROLLBACK');
    });

    it('Multitable insert calls rollback and release if commit fails on any', async () => {
        const queryTemplate1 = 'INSERT INTO schema1.table1 (column_1, column_2) VALUES %L RETURNING insertion_id';
        const queryColumns1 = '${column1}, ${column2}';
        const queryValues1 = [{ column1: 'Hello', column2: 'X' }, { column1: 'What', column2: 'Y' }];
        const goodInsert = { query: queryTemplate1, columnTemplate: queryColumns1, rows: queryValues1 };
        const expectedQuery1 = `INSERT INTO schema1.table1 (column_1, column_2) VALUES ('Hello', 'X'), ('What', 'Y') RETURNING insertion_id`;
        
        const badInsert = {
            query: 'INSERT STUFF BADLY IN FALSE WAYS %L',
            columnTemplate: '${column1}',
            rows: [{ column1: 123 }]
        };
        const formattedQueryBad = `INSERT STUFF BADLY IN FALSE WAYS ('123')`;

        queryStub.withArgs(expectedQuery1).resolves({ rows: [{ 'insertion_id': 1 }, { 'insertion_id': 2 }]});
        queryStub.withArgs(formattedQueryBad).rejects('PSQL ERROR! Bad insertion');

        await expect(rdsClient.largeMultiTableInsert([goodInsert, badInsert])).to.be.rejected.
            and.to.eventually.be.a('CommitError');

        // note: can't use standard expectations because we need two calls to query, one for each insert
        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledWithExactly('SET TRANSACTION READ WRITE');
        // logger('Query calls: ', queryStub.getCalls().map((call, index) => `${index}: ${JSON.stringify(call.args[0])}`));
        expect(queryStub).to.have.been.calledWithExactly(expectedQuery1);
        expect(queryStub).to.have.been.calledWithExactly(formattedQueryBad);
        expectTxWrapping('ROLLBACK');
        expect(queryStub).to.have.been.callCount(5);
        expect(releaseStub).to.have.been.calledOnce; 
    });

    it('Multitable update and insert calls rollback and release if commit fails on any', async () => {
        const testTime = new Date();
        const updateQueryKeyObject = { someId: 101, someTime: testTime };
        const updateQueryValueObject = { someStatus: 'SETTLED', someText: 'something_else', someBoolean: false };
        const updateDef = { table: 'schema1.tableX', key: updateQueryKeyObject, value: updateQueryValueObject, returnClause: 'updated_time' };

        const expectedUpdateQuery = 'UPDATE schema1.tableX SET some_status = $3, some_text = $4, some_boolean = $5 WHERE some_id = $1 and some_time = $2 RETURNING updated_time';
        const updateValues = [101, testTime, 'SETTLED', 'something_else', false];

        const insertQueryTemplate = 'INSERT INTO TABLE schema2.table1 (column_1, column_2) VALUES %L RETURNING insertion_id SOMETHING';
        const insertQueryColumns = '${column1}, ${column2}';
        const insertQueryValues = [{ column1: 'Hello', column2: 'X' }, { column1: 'What', column2: 'Y' }];
        const insertDef = { query: insertQueryTemplate, columnTemplate: insertQueryColumns, rows: insertQueryValues };
        
        const expectedInsertQuery = `INSERT INTO TABLE schema2.table1 (column_1, column_2) VALUES ('Hello', 'X'), ('What', 'Y') RETURNING insertion_id SOMETHING`;
        
        queryStub.withArgs(expectedUpdateQuery, sinon.match(updateValues)).resolves({ command: 'UPDATE', rows: [{ 'updated_time': new Date() }]});
        queryStub.withArgs(expectedInsertQuery).rejects('PSQL ERROR! Bad insertion');

        await expect(rdsClient.multiTableUpdateAndInsert([updateDef], [insertDef])).to.be.rejected;
        // note: as above, can't use standard expectations because we need two calls to query, one for update, one for insert
        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledWithExactly('SET TRANSACTION READ WRITE');
        // logger('Query calls: ', queryStub.getCalls().map((call, index) => `${index}: ${JSON.stringify(call.args[0])}`));
        expect(queryStub).to.have.been.calledWithExactly(expectedUpdateQuery, updateValues);
        expect(queryStub).to.have.been.calledWithExactly(expectedInsertQuery);
        expectTxWrapping('ROLLBACK');
        expect(queryStub).to.have.been.callCount(5);
        expect(releaseStub).to.have.been.calledOnce; 
    });

    it('Delete calls rollback and release if commit fails', async () => {
        const badDeleteQuery = 'DELETE FROM BADTABLE WHERE (column_1 = $1)';

        queryStub.withArgs(badDeleteQuery, ['causeFKviolation']).throws('Delete error');
        
        await expect(rdsClient.deleteRow('BADTABLE', ['column_1'], ['causeFKviolation'])).to.be.rejected.
            and.to.eventually.be.a('CommitError');

        standardExpectations(badDeleteQuery, ['causeFKviolation'], false, false, 'ROLLBACK');
    });

    it('Delete fails and calls rowback if attempts multiple at once', async () => {
        const badDeleteQuery = 'DELETE FROM BADTABLE WHERE (general_column = $1)';

        queryStub.withArgs(badDeleteQuery, ['trueForMany']).resolves({ command: 'DELETE', rowCount: 100 });

        await expect(rdsClient.deleteRow('BADTABLE', ['general_column'], ['trueForMany'])).to.be.rejected.
            and.to.eventually.be.a('CommitError');

        standardExpectations(badDeleteQuery, ['trueForMany'], false, false, 'ROLLBACK');
    });

    it('Failure to provide parameters on any method throws an error', async () => {
        await expect(rdsClient.selectQuery('SELECT 1')).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        await expect(rdsClient.updateRecord('UPDATE SOMETHING')).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        await expect(rdsClient.updateRecord('UPDATE ANOTHER', [])).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        await expect(rdsClient.insertRecords('INSERT SOMETHING')).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        await expect(rdsClient.insertRecords('INSERT SOMETHING', [])).to.be.rejected.and.to.eventually.be.a('NoValuesError');

        await expect(rdsClient.largeMultiTableInsert([{ query: 'INSERT SOMETHING WITHOUT VALUES' }])).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        
        const withBadSecondArg = [{ query: 'INSERT THIS IS FINE %L', columnTemplate: '${column1}', rows: [{ column1: 'somevalue'}]}, 
            { query: 'INSERT THIS ONE NOT SO MUCH %L', columnTemplate: '${columnX}' }];
        const badQueryVariant = JSON.parse(JSON.stringify(withBadSecondArg));
        badQueryVariant[1].query = 'INSERT SOMETHING NO VALUE PLACEHOLDER';
        badQueryVariant[1].rows = [{ columnX: 'somethingorother' }];
        await expect(rdsClient.largeMultiTableInsert(withBadSecondArg)).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        await expect(rdsClient.largeMultiTableInsert(badQueryVariant)).to.be.rejected.and.to.eventually.be.a('QueryError'); // because it has no %L

        expect(connectStub).to.not.have.been.called; // should not get there, in other words, in any of them
    });

    it('Failure to provide delete condition columns or values throws error, or if wildcard, or rows > 0', async () => {
        await expect(rdsClient.deleteRow('someTable', [], [])).to.be.rejected.and.to.eventually.be.a('NoValuesError');
        // await expect(rdsClient.deleteRow('someTable', ['someId'], ['*'])).to.be.rejected.and.to.eventually.be.a('QueryError');

    });

});
