'use strict';

const { QueryError, CommitError, NoValuesError } = require('../errors');

const logger = require('debug')('pluto:rds-common:unit-test');
const config = require('config');

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const chaiAsPromised = require('chai-as-promised');

const expect = chai.expect;

const proxyquire = require('proxyquire');

var queryStub = sinon.stub();
var releaseStub = sinon.stub();
var connectStub = sinon.stub().resolves({ 
    query: queryStub,
    release: releaseStub
});

var endStub = sinon.stub();

chai.use(sinonChai);
chai.use(chaiAsPromised);

class MockPostgres {
    constructor(config) {
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
}

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

    var rdsClient;

    const select1result = { command: 'SELECT', rowCount: 1, rows: [ {'?column?': 1 }]};

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
        const result = { command: 'SELECT', rowCount: 2, rows: [ {'id': 2, 'column_1': 'apples'}, {'id': 3, 'column_1': 'oranges'} ]};
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
        const result = { command: 'UPDATE' }; // todo : return successful
        queryStub.withArgs(updateQuery, updateValues).resolves(result);

        const updateResult = await rdsClient.updateRecord(updateQuery, updateValues);
        logger('Update result ? : ', updateResult);
        expect(updateResult).to.exist;
        expect(updateResult).to.eql(result);
        // as above, on ordering; also that default client connection state should be read only
        standardExpectations(updateQuery, updateValues, false, false, 'COMMIT');
    });

});

describe('*** UNIT TEST BULK ROW INSERTION ***', () => {

    var rdsClient;
    before(() => {
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });

    afterEach(() => {
        clearStubHistory();
    });

    it('Assembles row insertion properly', async () => {
        const queryTemplate = 'INSERT INTO some_schema.some_table (column_1, column_2) VALUES %L';
        const columnTemplate = '${column_1}, ${column_2}';
        const queryValues = [ { column_1: 'Hello', column_2: 'World' }, { column_1: 'Something', column_2: 'Else' }];

        const expectedValue = '(\'Hello\', \'World\'), (\'Something\', \'Else\')';
        const expectedQuery = 'INSERT INTO some_schema.some_table (column_1, column_2) VALUES ' + expectedValue;

        queryStub.withArgs(expectedQuery).returns('Hallelujah');

        const insertResult = await rdsClient.insertRecords(queryTemplate, columnTemplate, queryValues);
        expect(insertResult).to.exist; // todo : also check for the return of indices
        
        standardExpectations(expectedQuery, null, false, false, 'COMMIT');
    });

    it('Sanitizes values properly to prevent injection', async () => {
        const queryTemplate = 'INSERT INTO some_scema.some_table (column_1, column_2) VALUES $1';
        const maliciousValue = [ { column_1: 'Watch this', column_2: `'End'); DROP TABLE Users`}];

        expect(rdsClient.insertRecords.bind(rdsClient, queryTemplate, maliciousValue)).to.throw(QueryError);
        expect(connectStub).to.not.have.been.called;
        expect(queryStub).to.not.have.been.called;
    });

    it('Processes multi-insert queries properly', async () => {
        const queryTemplate1 = 'INSERT INTO schema1.table1 (column_1, column_2) VALUES $1';
        const queryValues1 = [ { column_1: 'Hello', column_2: 'X' }, { column_1: 'What', column_2: 'Y' } ];
        const queryDef1 = { queryTemplate: queryTemplate1, queryValues: queryValues1 };
        const expectedQuery1 = `INSERT INTO schema1.table1 (column_1, column_2) VALUES ('Hello', 'X'), ('What', 'Y')`;
        
        const queryTemplate2 = 'INSERT INTO schema2.table1 (column_1, column_2) VALUES $1';
        const queryValues2 = [ { column_1: 'Other', column_2: 'Thing' }, { column_1: 'Hey', column_2: 'Over'} ];
        const queryDef2 = { queryTemplate: queryTemplate2, queryValues: queryValues2 };
        const expectedQuery2 = `INSERT INTO schema2.table1 (column_1, column_2) VALUES ('Other', 'Thing'), ('Hey', 'Over')`;

        const insertResult = await rdsClient.largeMultiTableInsert([queryDef1, queryDef2]);

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

describe('*** UNIT TEST BASIC POOL MGMT ***', () => {
    var rdsClient;

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

    var rdsClient;

    before(() => {
        rdsClient = new RdsConnection({db: config.get('db.testDb'), user: config.get('db.testUser'), password: config.get('db.testPassword')});
    });

    afterEach(() => {
        connectStub.resetHistory();
        queryStub.resetHistory();
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

        const commitError = new CommitError('INSERT CONFLICTING THING', [ { id: 'conflicting_id' }]);
        expect(commitError.data.template).to.equal('INSERT CONFLICTING THING');
        expect(commitError.data.values).to.eql([ { id: 'conflicting_id' }]);

        const noValuesError = new NoValuesError('SELECT 1');
        expect(noValuesError.data.template).to.equal('SELECT 1'); 
    });

    it('Connection release is called if selection query fails', async () => {
        const badSelectionQuery = 'SELECT bad syntax who knows what this person is doing';
        queryStub.withArgs(badSelectionQuery, []).throws('Bad query'); // todo : adjust to actual
        
        // note: deeper checks on error class etc., are failing on JS equality badness, so doing this as equivalent
        const expectedMsg = `Query with template ${badSelectionQuery} and values ${JSON.stringify([])} caused an error.`;
        await expect(rdsClient.selectQuery(badSelectionQuery, [])).to.be.rejected
            .and.to.eventually.have.property('message', expectedMsg);
        standardExpectations(badSelectionQuery, [], 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', true);
    });

    it('Update transaction calls rollback and release if commit fails', () => {
        const badUpdateQuery = 'UPDATE THINGS INTO bad syntax who knows what this person is doing';
        const mockValues = [1500, 1];
        queryStub.withArgs(badUpdateQuery, mockValues).throws('Bad query'); // as above

        expect(rdsClient.updateRecord.bind(rdsClient, badUpdateQuery, mockValues)).to.throw(QueryError);
        standardExpectations(badUpdateQuery, mockValues, 'SET TRANSACTION READ WRITE', false, 'ROLLBACK');
    });

    it('Insert calls throw error if badly templated', () => {
        const badQuery = 'INSERT WITHOUT VALUE';
        const badValues = [];

        expect(rdsClient.insertRecords.bind(rdsClient, badQuery, badValues)).to.throw(QueryError);
        expect(connectStub).to.not.have.been.called;
    });

    it('Insert calls rollback and release if commit fails', () => {
        const badInsertQuery = 'INSERT STUFF BADLY IN FALSE WAYS $1';
        const badValues = [{ column_1: 123 }];

        expect(rdsClient.insertRecords.bind(rdsClient, badInsertQuery, badValues)).to.throw(CommitError);
        standardExpectations(badInsertQuery, badValues, 'SET TRANSACTION READ WRITE', false, 'ROLLBACK');
    });

    it('Failure to provide parameters on any method throws an error', () => {
        expect(rdsClient.selectQuery.bind(rdsClient, 'SELECT 1')).to.throw(NoValuesError);
        expect(rdsClient.updateRecord.bind(rdsClient, 'UPDATE SOMETHING')).to.throw(NoValuesError);
        expect(rdsClient.updateRecord.bind(rdsClient, 'UPDATE ANOTHER', [])).to.throw(NoValuesError);
        expect(rdsClient.insertRecords.bind(rdsClient, 'INSERT SOMETHING')).to.throw(NoValuesError);
        expect(rdsClient.insertRecords.bind(rdsClient, 'INSERT SOMETHING', [])).to.throw(NoValuesError);

        expect(connectStub).to.not.have.been.called; // should not get there, in other words, in any of them
        // todo : also write for multi table
    });

});