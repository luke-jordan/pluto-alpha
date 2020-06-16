'use strict';

process.env.NODE_ENV = 'test';

// const logger = require('debug')('jupiter:factoid-rds:test');
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
        this.updateRecordObject = updateRecordStub;
    }
}

const rds = proxyquire('../persistence/rds.factoids', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe('*** UNIT TEST FACTOID RDS FUNCTIONS ***', () => {
    const testFactId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        helper.resetStubs(queryStub, insertStub, updateRecordStub);
    });

    it('Persists new factoids', async () => {
        const insertQuery = 'insert into factoid_data.factoid (title, body, active, factoid_id) values %L returning creation_time';
        const expectedColumns = '${title}, ${body}, ${active}, ${factoidId}';

        const expectedFactoid = {
            title: 'Jupiter Fun Fact #12',
            body: 'Jupiter helps you grow.',
            active: true,
            factoidId: testFactId
        };

        uuidStub.returns(testFactId);
        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const testFactoid = {
            title: 'Jupiter Fun Fact #12',
            body: 'Jupiter helps you grow.',
            active: true
        };

        const resultOfInsert = await rds.addFactoid(testFactoid);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ creationTime: testCreationTime });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, expectedColumns, [expectedFactoid]);
    });

    it('Fetches factoid properly', async () => {
        const mockFactoid = {
            title: 'Jupiter Factoid #21',
            body: 'Jupiter helps you save.'
        };

        const selectQuery = 'select * from factoid_data.factoid where factoid_id not in (select factoid_id ' +
            'from factoid_data.factoid_user_join_table where user_id = $1)';

        queryStub.resolves([{ 'title': 'Jupiter Factoid #21', 'body': 'Jupiter helps you save.' }]);

        const resultOfFetch = await rds.fetchUnreadFactoids(testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([mockFactoid]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testSystemId]);
    });

    it('Updates factoid properly', async () => {
        const mockUpdateDef = { 
            key: { factoidId: testFactId },
            value: { body: 'Jupiter rewards you for saving', active: true },
            table: config.get('tables.factoidTable'),
            returnClause: 'updated_time'
        };

        updateRecordStub.resolves([{ 'updated_time': testUpdatedTime }]);

        const testUpdateParams = {
            factoidId: testFactId,
            body: 'Jupiter rewards you for saving',
            active: true
        };
        
        const resultOfUpdate = await rds.updateFactoid(testUpdateParams);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(mockUpdateDef);
    });

    it('Marks a factoid as viewed by a user', async () => {
        const insertArgs = {
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: 'VIEWED'
        };

        const insertQuery = 'insert into factoid_data.factoid_user_join_table (user_id, factoid_id, factoid_status) ' +
            'values %L returning creation_time';
        const expectedColumns = '${userId}, ${factoidId}, ${factoidStatus}';

        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const resultOfInsert = await rds.updateFactoidToViewed(testSystemId, testFactId);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ creationTime: testCreationTime });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, expectedColumns, [insertArgs]);
    });
});
