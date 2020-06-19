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
const updateStub = sinon.stub();
const updateRecordObjStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.updateRecord = updateStub,
        this.updateRecordObject = updateRecordObjStub;
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

    const mockFactoidFromRds = {
        'factoid_id': testFactId,
        'title': 'Jupiter Factoid #21',
        'body': 'Jupiter helps you save.',
        'factoid_status': 'PUSHED',
        'factoid_priority': 2,
        'creation_time': testCreationTime,
        'updated_time': testUpdatedTime,
        'country_code': 'ZAF'
    };

    beforeEach(() => {
        helper.resetStubs(queryStub, insertStub, updateStub, updateRecordObjStub);
    });

    it('Persists new factoids', async () => {
        const insertQuery = 'insert into factoid_data.factoid (title, body, active, factoid_id) values %L returning creation_time';
        const expectedColumns = '${title}, ${body}, ${active}, ${factoidId}';

        const expectedInsertObj = {
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
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, expectedColumns, [expectedInsertObj]);
    });

    it('Pushes a factoid to a user (creates new entry in user-factoid join table', async () => {
        const insertQuery = 'insert into factoid_data.factoid_user_join_table (user_id, factoid_id, factoid_status) values %L returning creation_time';
        const expectedColumns = '${userId}, ${factoidId}, ${factoidStatus}';

        const expectedInsertObj = {
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: 'PUSHED'
        };

        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const resultOfInsert = await rds.pushFactoidToUser(testFactId, testSystemId);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ creationTime: testCreationTime });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, expectedColumns, [expectedInsertObj]);
    });

    it('Fetches factoid details from user-factoid join table', async () => {
        const mockFactoidDetailsFromRds = {
            'user_id': testSystemId,
            'factoid_id': testFactId,
            'factoid_status': 'PUSHED',
            'read_count': 2,
            'fetch_count': 3,
            'creation_time': testCreationTime,
            'updated_time': testUpdatedTime
        };

        const expectedDetails = {
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: 'PUSHED',
            readCount: 2,
            fetchCount: 3,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime
        };

        const selectQuery = `select * from factoid_data.factoid_user_join_table where user_id = $1 and factoid_id in ($2, $3)`;

        queryStub.resolves([mockFactoidDetailsFromRds, mockFactoidDetailsFromRds]);

        const resultOfFetch = await rds.fetchFactoidDetails([testFactId, testFactId], testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedDetails, expectedDetails]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testSystemId, testFactId, testFactId]);
    });

    it('Fetches unviewed factoids properly', async () => {
        const mockFactoid = {
            factoidId: testFactId,
            title: 'Jupiter Factoid #21',
            body: 'Jupiter helps you save.',
            factoidStatus: 'PUSHED',
            factoidPriority: 2,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime,
            countryCode: 'ZAF'
        };


        const selectQuery = `select * from factoid_data.factoid where factoid_id not in ` +
            `(select factoid_id from factoid_data.factoid_user_join_table where user_id = $1 and factoid_status = $2)`;


        queryStub.resolves([mockFactoidFromRds, mockFactoidFromRds]);

        const resultOfFetch = await rds.fetchUnviewedFactoids(testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([mockFactoid, mockFactoid]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testSystemId, 'VIEWED']);
    });

    it('Fetches viewed factoids properly', async () => {
        const factoidFromRds = { ...mockFactoidFromRds };
        factoidFromRds['factoid_status'] = 'VIEWED';
        const mockFactoid = {
            factoidId: testFactId,
            title: 'Jupiter Factoid #21',
            body: 'Jupiter helps you save.',
            factoidStatus: 'VIEWED',
            factoidPriority: 2,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime,
            countryCode: 'ZAF'
        };

        const selectQuery = `select * from factoid_data.factoid where factoid_id in (select factoid_id from ` +
            `factoid_data.factoid_user_join_table where user_id = $1)`;

        queryStub.resolves([factoidFromRds, factoidFromRds]);

        const resultOfFetch = await rds.fetchViewedFactoids(testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([mockFactoid, mockFactoid]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testSystemId]);
    });

    it('Increments a factoid view or fetch count', async () => {
        const updateQuery = `UPDATE factoid_data.factoid_user_join_table SET read_count = read_count + 1 WHERE factoid_id = $1 ` +
            `and user_id = $2 returning updated_time`;

        updateStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});

        const resultOfUpdate = await rds.incrementCount(testFactId, testSystemId, 'VIEWED');

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, [testFactId, testSystemId]);
    });

    it('Updates factoid status properly', async () => {
        const updateQuery = `UPDATE factoid_data.factoid_user_join_table SET factoid_status = $1 WHERE factoid_id = $2 ` +
                `and user_id = $3 returning updated_time`;

        updateStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});

        const resultOfUpdate = await rds.updateFactoidStatus(testFactId, testSystemId, 'PUSHED');

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, ['PUSHED', testFactId, testSystemId]);
    });

    it('Updates factoid properly', async () => {
        const mockUpdateDef = { 
            key: { factoidId: testFactId },
            value: { body: 'Jupiter rewards you for saving', active: true },
            table: config.get('tables.factoidTable'),
            returnClause: 'updated_time'
        };

        updateRecordObjStub.resolves([{ 'updated_time': testUpdatedTime }]);

        const testUpdateParams = {
            factoidId: testFactId,
            body: 'Jupiter rewards you for saving',
            active: true
        };
        
        const resultOfUpdate = await rds.updateFactoid(testUpdateParams);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateRecordObjStub).to.have.been.calledOnceWithExactly(mockUpdateDef);
    });
});
