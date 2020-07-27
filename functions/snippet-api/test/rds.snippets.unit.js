'use strict';

// const logger = require('debug')('jupiter:snippet-rds:test');
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
        this.updateRecord = updateStub;
        this.updateRecordObject = updateRecordObjStub;
    }
}

const rds = proxyquire('../persistence/rds.snippets', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe('*** UNIT TEST SNIPPET RDS FUNCTIONS ***', () => {
    const testSnippetId = uuid();
    const testSystemId = uuid();
    const testAdminId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockSnippetFromRds = {
        'snippet_id': testSnippetId,
        'title': 'Jupiter Snippet #21',
        'body': 'Jupiter helps you save.',
        'active': true,
        'snippet_priority': 2,
        'creation_time': testCreationTime,
        'updated_time': testUpdatedTime,
        'country_code': 'ZAF'
    };

    beforeEach(() => {
        helper.resetStubs(queryStub, insertStub, updateStub, updateRecordObjStub);
    });

    it('Persists snippets properly', async () => {
        const insertQuery = 'insert into snippet_data.snippet (title, body, active, snippet_id) values %L returning creation_time';
        const expectedColumns = '${title}, ${body}, ${active}, ${snippetId}';

        const expectedInsertObj = {
            title: 'Jupiter Fun Fact #12',
            body: 'Jupiter helps you grow.',
            active: true,
            snippetId: testSnippetId
        };

        uuidStub.returns(testSnippetId);
        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const testSnippet = {
            title: 'Jupiter Fun Fact #12',
            body: 'Jupiter helps you grow.',
            active: true
        };

        const resultOfInsert = await rds.addSnippet(testSnippet);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ creationTime: testCreationTime });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, expectedColumns, [expectedInsertObj]);
    });

    it('Creates new entry in user-snippet join table', async () => {
        const insertQuery = 'insert into snippet_data.snippet_user_join_table (user_id, snippet_id, snippet_status) values %L returning creation_time';
        const expectedColumns = '${userId}, ${snippetId}, ${snippetStatus}';

        const expectedInsertObj = {
            userId: testSystemId,
            snippetId: testSnippetId,
            snippetStatus: 'CREATED'
        };

        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const resultOfInsert = await rds.createSnippetUserJoin(testSnippetId, testSystemId);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ creationTime: testCreationTime });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, expectedColumns, [expectedInsertObj]);
    });

    it('Fetches user-snippet statuses from join table', async () => {
        const mockSnippetJoinRaw = {
            'user_id': testSystemId,
            'snippet_id': testSnippetId,
            'snippet_status': 'FETCHED',
            'view_count': 2,
            'fetch_count': 3,
            'creation_time': testCreationTime,
            'updated_time': testUpdatedTime
        };

        const expectedSnippetStatus = {
            userId: testSystemId,
            snippetId: testSnippetId,
            snippetStatus: 'FETCHED',
            viewCount: 2,
            fetchCount: 3,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime
        };

        const selectQuery = `select * from snippet_data.snippet_user_join_table where user_id = $1 and snippet_id in ($2, $3)`;

        queryStub.resolves([mockSnippetJoinRaw, mockSnippetJoinRaw]);

        const resultOfFetch = await rds.fetchSnippetUserStatuses([testSnippetId, testSnippetId], testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedSnippetStatus, expectedSnippetStatus]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testSystemId, testSnippetId, testSnippetId]);
    });

    it('Fetches uncreated snippets properly', async () => {
        const mockSnippetFromPersistence = { ...mockSnippetFromRds };
        mockSnippetFromPersistence['snippet_status'] = 'UNCREATED';
        const expectedSnippet = {
            snippetId: testSnippetId,
            title: 'Jupiter Snippet #21',
            body: 'Jupiter helps you save.',
            active: true,
            fetchCount: 0,
            viewCount: 0,
            snippetStatus: 'UNCREATED',
            snippetPriority: 2
        };

        const selectQuery = `select * from snippet_data.snippet where active = $1 and snippet_id not in ` +
            `(select snippet_id from snippet_data.snippet_user_join_table where user_id = $2 and snippet_status = $3)`;

        queryStub.resolves([mockSnippetFromPersistence, mockSnippetFromPersistence]);

        const resultOfFetch = await rds.fetchUncreatedSnippets(testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedSnippet, expectedSnippet]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [true, testSystemId, 'VIEWED']);
    });

    it('Fetches created snippets properly', async () => {
        const snippetFromRds = { ...mockSnippetFromRds };
        snippetFromRds['snippet_status'] = 'VIEWED';
        const expectedSnippet = {
            snippetId: testSnippetId,
            title: 'Jupiter Snippet #21',
            body: 'Jupiter helps you save.',
            active: true,
            fetchCount: 0,
            viewCount: 0,
            snippetStatus: 'VIEWED',
            snippetPriority: 2
        };

        const selectQuery = `select * from snippet_data.snippet_user_join_table inner join snippet_data.snippet ` +
            `on snippet_data.snippet_user_join_table.snippet_id = snippet_data.snippet.snippet_id ` +
            `where user_id = $1 and active = $2`;           
        
        queryStub.resolves([snippetFromRds, snippetFromRds]);

        const resultOfFetch = await rds.fetchCreatedSnippets(testSystemId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedSnippet, expectedSnippet]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testSystemId, true]);
    });

    it('Fetches preview snippets', async () => {
        const expectedSnippet = {
            snippetId: testSnippetId,
            title: 'Jupiter Snippet #21',
            body: 'Jupiter helps you save.',
            active: true,
            fetchCount: 0,
            viewCount: 0,
            snippetStatus: 'UNCREATED',
            snippetPriority: 2
        };

        const selectQuery = `select * from snippet_data.snippet where preview_mode = $1`;
        
        queryStub.resolves([mockSnippetFromRds, mockSnippetFromRds]);

        const resultOfFetch = await rds.fetchPreviewSnippets();

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedSnippet, expectedSnippet]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [true]);
    });

    it('Asserts whether a user may preview snippets', async () => {
        const selectQuery = 'select user_id from snippet_data.preview_user_table where user_id = $1 and active = $2';
        queryStub.resolves([{ 'user_id': testSystemId }]);
        const resultOfFetch = await rds.isPreviewUser(testSystemId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.be.true;
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testSystemId, true]);
    });

    it('Inserts a new preview user', async () => {
        queryStub.resolves([]);
        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});

        const findQuery = 'select * from snippet_data.preview_user_table where user_id = $1';
        const insertQuery = 'insert into snippet_data.preview_user_table (user_id) values %L returning creation_time';

        const resultOfInsert = await rds.insertPreviewUser(testSystemId);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ creationTime: testCreationTime });
        expect(queryStub).to.have.been.calledOnceWithExactly(findQuery, [testSystemId]);
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, '${userId}', [{ userId: testSystemId}]);
        expect(updateStub).to.have.not.been.called;
    });

    it('Reactivates a pre-existing preview user', async () => {
        queryStub.resolves([{ 'user_id': testSystemId, 'active': false }]);
        updateStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});

        const findQuery = 'select * from snippet_data.preview_user_table where user_id = $1';
        const updateQuery = 'update snippet_data.preview_user_table set active = $1 where user_id = $2 returning updated_time';

        const resultOfInsert = await rds.insertPreviewUser(testSystemId);

        expect(resultOfInsert).to.exist;
        expect(resultOfInsert).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(queryStub).to.have.been.calledOnceWithExactly(findQuery, [testSystemId]);
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, [true, testSystemId]);
        expect(insertStub).to.have.not.been.called;
    });

    it('Removes a preview user properly', async () => {
        updateStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});
        const updateQuery = 'update snippet_data.preview_user_table set active = $1 where user_id = $2 returning updated_time';
        const resultOfUpdate = await rds.removePreviewUser(testSystemId);
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, [false, testSystemId]);
    });

    it('Increments a snippet view or fetch count', async () => {
        const updateQuery = `update snippet_data.snippet_user_join_table set view_count = view_count + 1 where snippet_id = $1 ` +
            `and user_id = $2 returning view_count, updated_time`;

        updateStub.resolves({ rows: [{ 'view_count': 3, 'updated_time': testUpdatedTime }]});

        const resultOfUpdate = await rds.incrementCount(testSnippetId, testSystemId, 'VIEWED');

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ viewCount: 3, updatedTime: testUpdatedTime });
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, [testSnippetId, testSystemId]);
        await expect(rds.incrementCount(testSnippetId, testSystemId, 'BAD_STATUS')).to.eventually.be.rejectedWith('Invalid status: BAD_STATUS');
    });

    it('Updates snippet status properly', async () => {
        const updateQuery = `update snippet_data.snippet_user_join_table set snippet_status = $1 where snippet_id = $2 ` +
                `and user_id = $3 returning updated_time`;

        updateStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});

        const resultOfUpdate = await rds.updateSnippetStatus(testSnippetId, testSystemId, 'FETCHED');

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, ['FETCHED', testSnippetId, testSystemId]);
    });

    it('Updates snippet properly', async () => {
        const mockUpdateDef = { 
            key: { snippetId: testSnippetId },
            value: { body: 'Jupiter rewards you for saving', active: true },
            table: config.get('tables.snippetTable'),
            returnClause: 'updated_time'
        };

        updateRecordObjStub.resolves([{ 'updated_time': testUpdatedTime }]);

        const testUpdateParams = {
            snippetId: testSnippetId,
            body: 'Jupiter rewards you for saving',
            active: true
        };
        
        const resultOfUpdate = await rds.updateSnippet(testUpdateParams);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal({ updatedTime: testUpdatedTime });
        expect(updateRecordObjStub).to.have.been.calledOnceWithExactly(mockUpdateDef);
    });

    it('Logs snippet events', async () => {
        const testLogId = uuid();
        const expectedLogRow = {
            logId: testLogId,
            userId: testSystemId,
            snippetId: testSnippetId,
            logType: 'SNIPPET_VIEWED',
            logContext: { some: 'value' }
        };

        const insertQuery = `insert into snippet_data.snippet_log (log_id, user_id, snippet_id, log_type, log_context) values %L returning log_id`;
        const columnTemplate = '${logId}, ${userId}, ${snippetId}, ${logType}, ${logContext}';

        uuidStub.returns(testLogId);
        insertStub.resolves({ rows: [{ 'log_id': testLogId }]});

        const testLogObject = {
            userId: testSystemId,
            snippetId: testSnippetId,
            logType: 'SNIPPET_VIEWED',
            logContext: { some: 'value' }
        };

        const resultOfLog = await rds.insertSnippetLog(testLogObject);

        expect(resultOfLog).to.exist;
        expect(resultOfLog).to.deep.equal(testLogId);
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, columnTemplate, [expectedLogRow]);
    });

    it('Fetches all active snippets (admin)', async () => {
        const mockSnippetAndUserCountFromRds = {
            'snippet_id': testSnippetId,
            'title': 'Jupiter Snippet #21',
            'body': 'Jupiter helps you save.',
            'snippet_priority': 5,
            'preview_mode': true,
            'snippet_language': 'en',
            'country_code': 'ZAF',
            'active': true,
            'created_by': testAdminId,
            'creation_time': testCreationTime,
            'updated_time': testUpdatedTime,
            'user_count': 610
        };

        const expectedSnippet = {
            snippetId: testSnippetId,
            title: 'Jupiter Snippet #21',
            body: 'Jupiter helps you save.',
            active: true,
            snippetPriority: 5,
            snippetLanguage: 'en',
            previewMode: true,
            countryCode: 'ZAF',
            createdBy: testAdminId,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime,
            userCount: 610
        };

        queryStub.resolves([mockSnippetAndUserCountFromRds, mockSnippetAndUserCountFromRds]);

        const selectQuery = 'select snippet_data.snippet.*, count(distinct(user_id)) as user_count from snippet_data.snippet left join ' +
            'snippet_data.snippet_user_join_table on snippet_data.snippet.snippet_id = snippet_data.snippet_user_join_table.snippet_id ' +
            'where active = $1 group by snippet_data.snippet.snippet_id';

        const resultOfFetch = await rds.fetchSnippetsAndUserCount();

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal([expectedSnippet, expectedSnippet]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [true]);
    });

    it('Fetches a snippet (admin)', async () => {
        const expectedSnippet = {
            snippetId: testSnippetId,
            title: 'Jupiter Snippet #21',
            body: 'Jupiter helps you save.',
            active: true,
            snippetPriority: 2,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime,
            countryCode: 'ZAF'
        };

        queryStub.resolves([mockSnippetFromRds]);

        const selectQuery = 'select * from snippet_data.snippet where snippet_id = $1';

        const resultOfFetch = await rds.fetchSnippetForAdmin(testSnippetId);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal(expectedSnippet);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testSnippetId]);
    });

    it('Counts the total times a snippet has been created, fetched, and viewed', async () => {
        queryStub.resolves([{ 'sum_users': 89, 'sum_views': 112, 'sum_fetches': 358 }]);
        const selectQuery = 'select count(distinct(user_id)) as sum_users, sum(view_count) as sum_views, sum(fetch_count) as sum_fetches from ' +
            'snippet_data.snippet_user_join_table where snippet_id = $1 group by snippet_id';
        const resultOfFetch = await rds.countSnippetEvents(testSnippetId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.deep.equal({ sumUsers: 89, sumViews: 112, sumFetches: 358 });
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [testSnippetId]);
    });

});
