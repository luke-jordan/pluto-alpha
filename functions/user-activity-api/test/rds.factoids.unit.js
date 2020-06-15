'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:factoid-rds:test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const helper = require('./test.helper');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const updateRecordStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.updateRecord = updateRecordStub;
    }
}

const rds = proxyquire('../persistence/factoids', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe.only('*** UNIT TEST FACTOID RDS FUNCTIONS ***', () => {
    const testFactId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    it('Persists new factoids', async () => {
        uuidStub.returns(testFactId);
        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const testFactoid = {
            title: 'Jupiter Fun Fact #12',
            body: 'Jupiter helps you grow.',
            active: true
        };

        const resultOfInsert = await rds.addFactoid(testFactoid);
        logger('Result:', resultOfInsert)
    });

    it.only('Updates factoid properly', async () => {
        const updateQuery = 'update factoid_data.factoid set body = $1, active = $2 where factoid_id = $3 returning updated_time';
        const updateValues = ['upiter rewards you for saving', true, testFactId];

        updateRecordStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});

        const testUpdateParams = {
            factoidId: testFactId,
            body: 'Jupiter rewards you for saving',
            active: true
        };
        
        const resultOfUpdate = await rds.updateFactoid(testUpdateParams);
        logger('Result:', resultOfUpdate)

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        // expect(updateRecordStub).to.have.been.calledOnceWithExactly(updateQuery, [])
    });

    it('Fetches factoid properly', async () => {
        const expectedResult = {
            title: 'Jupiter Factoid #21',
            body: 'Jupiter helps you save.'
        };

        const findQuery = `select factoid_id from factoid_data.preview_table where user_id = $1 and factoid_status = $2`;
        const selectQuery = 'select title, body from factoid_data.factoid where factoid_id not in ($1, $2) limit 1';

        queryStub.onFirstCall().resolves([{ 'factoid_id': testFactId }, { 'factoid_id': testFactId }]);
        queryStub.onSecondCall().resolves([{ 'title': 'Jupiter Factoid #21', 'body': 'Jupiter helps you save.' }]);

        const resultOfFetch = await rds.fetchUnreadFactoid(testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledWithExactly(findQuery, [testSystemId, 'VIEWED']);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testFactId, testFactId]);
        expect(queryStub).to.have.been.calledTwice;
    });
});