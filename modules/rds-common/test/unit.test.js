'use strict';

const { QueryError, CommitError, NoValuesError } = require('../errors');

const logger = require('debug')('pluto:rds-common:unit-test');
const config = require('config');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

const proxyquire = require('proxyquire');

var queryStub = sinon.stub();
var releaseStub = sinon.stub();
var connectStub = sinon.stub().resolves({ 
    query: queryStub,
    release: releaseStub
});

var endStub = sinon.stub();

class MockPostgres {
    constructor(any) {
        this.connect = connectStub;
        this.query = queryStub;
        this.end = endStub;
    }
}

const RdsConnection = proxyquire('../index', {
    'pg': { Pool: MockPostgres },
    '@noCallThru': true
});

describe('Basic query pass through', () => {

    var rdsClient;

    const select1result = { command: 'SELECT', rowCount: 1, rows: [ {'?column?': 1 }]};

    before(() => {
        queryStub.withArgs('SELECT 1').returns(select1result);
        rdsClient = new RdsConnection(config.get('db.testDb'), config.get('db.testUser'), config.get('db.testPassword'));
    });

    after(() => {
        queryStub.reset();
    })
    
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
        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledOnceWithExactly('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;');
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, selectValues);
        expect(releaseStub).to.have.been.calledOnce();
    });

    it('Runs an update query properly', async () => {
        const updateQuery = 'UPDATE table SET column_1 = $1 WHERE id = $2';
        const updateValues = [1500, 1];
        const result = { command: 'UPDATE' }; // todo : return successful
        queryStub.withArgs(updateQuery, updateValues).resolves(result);

        const updateResult = await rdsClient.updateRecord(updateQuery, updateValues);
        expect(updateResult).to.exist;
        expect(updateResult).to.eql(result);
        // as above, on ordering; also that default client connection state should be read only
        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledOnceWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledOnceWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledOnceWithExactly(updateQuery, updateValues);
        expect(queryStub).to.have.been.calledOnceWithExactly('COMMIT');
        expect(releaseStub).to.have.been.calledOnce();
    });

});

describe('Bulk row insertion', () => {

    var rdsClient;
    before(() => {
        rdsClient = new RdsConnection(config.get('db.testDb'), config.get('db.testUser'), config.get('db.testPassword'));
    });

    it('Assembles row insertion properly', async () => {
        const queryTemplate = 'INSERT INTO some_schema.some_table (column_1, column_2) VALUES $1';
        const queryValues = [ { column_1: 'Hello', column_2: 'World' }, { column_1: 'Something', column_2: 'Else' }];

        const expectedQuery = `INSERT INTO some_schema.some_table (column_1, column_2) VALUES ('Hello', 'World'), ('Something', 'Else')`;

        const insertResult = await rdsClient.insertRecords(queryTemplate, queryValues);
        expect(insertResult).to.exist; // todo : also check for the return of indices

        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledOnceWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledOnceWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery);
        expect(queryStub).to.have.been.calledOnceWithExactly('COMMIT');
        expect(releaseStub).to.have.been.calledOnce();
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

        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledOnceWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledOnceWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery1);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery2);
        expect(queryStub).to.have.been.calledOnceWithExactly('COMMIT');
        expect(releaseStub).to.have.been.calledOnce();
    });
});

describe('Basic pool and connection management', () => {
    var rdsClient;
    before(() => {
        rdsClient = new RdsConnection(config.get('db.testDb'), config.get('db.testUser'), config.get('db.testPassword'));
    });

    it('Testing the pool tests the pool', async () => {
        await rdsClient.testPool();
        expect(queryStub).to.have.been.calledOnceWithExactly('SELECT 1');
    });

    it('Calling end pool drains it', async () => {
        await rdsClient.endPool();
        expect(endStub).to.have.been.calledOnceWithExactly();
    });

});

describe('Error handling, including connection release, non-parameterized queries, pool exhausted, etc', () => {

    var rdsClient;
    before(() => {
        rdsClient = new RdsConnection(config.get('db.testDb'), config.get('db.testUser'), config.get('db.testPassword'));
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

    it('Connection release is called if selection query fails', () => {
        const badSelectionQuery = 'SELECT bad syntax who knows what this person is doing';
        queryStub.withArgs(badSelectionQuery).throws('Bad query'); // todo : adjust to actual
        
        expect(rdsClient.selectQuery.bind(rdsClient, badSelectionQuery, [])).to.throw(QueryError);
        expect(connectStub).to.have.been.calledOnce();
        expect(queryStub).to.have.been.calledOnceWithExactly('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;');
        expect(queryStub).to.have.been.calledOnceWithExactly(badSelectionQuery, []);
        expect(releaseStub).to.have.been.calledOnce();
    });

    it('Update transaction calls rollback and release if commit fails', () => {
        const badUpdateQuery = 'UPDATE THINGS INTO bad syntax who knows what this person is doing';
        const mockValues = [1500, 1];
        queryStub.withArgs(badUpdateQuery, mockValues).throws('Bad query'); // as above

        expect(rdsClient.updateRecord.bind(rdsClient, badUpdateQuery, mockValues)).to.throw(QueryError);
        // as above, on ordering; also that default client connection state should be read only
        expect(connectStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledOnceWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledOnceWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledOnceWithExactly(updateQuery, updateValues);
        expect(queryStub).to.have.been.calledOnceWithExactly('ROLLBACK');
        expect(releaseStub).to.have.been.calledOnce;
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

        expect(connectStub).to.have.been.calledOnce;
        expect(rdsClient.insertRecords.bind(rdsClient, badInsertQuery, badValues)).to.throw(CommitError);
        expect(queryStub).to.have.been.calledOnceWithExactly('BEGIN');
        expect(queryStub).to.have.been.calledOnceWithExactly('SET TRANSACTION READ WRITE');
        expect(queryStub).to.have.been.calledOnceWithExactly(badInsertQuery, badValues);
        expect(queryStub).to.have.been.calledOnceWithExactly('ROLLBACK');
        expect(releaseStub).to.have.been.calledOnce();
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