'use strict';

// const logger = require('debug')('jupiter:snippet:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./test.helper');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const createSnippetJoinStub = sinon.stub();
const fetchUncreatedSnippetsStub = sinon.stub();
const fetchCreatedSnippetsStub = sinon.stub();
const incrementStub = sinon.stub();
const updateSnippetStatusStub = sinon.stub();
const fetchSnippetStatusesStub = sinon.stub();
const queueEventsStub = sinon.stub();
const insertLogStub = sinon.stub();
const isPreviewUserStub = sinon.stub();
const previewSnippetStub = sinon.stub();

const handler = proxyquire('../snippet-handler', {
    'publish-common': {
        'sendToQueue': queueEventsStub
    },
    './persistence/rds.snippets': {
        'fetchSnippetUserStatuses': fetchSnippetStatusesStub,
        'incrementCount': incrementStub,
        'updateSnippetStatus': updateSnippetStatusStub,
        'createSnippetUserJoin': createSnippetJoinStub,
        'fetchUncreatedSnippets': fetchUncreatedSnippetsStub,
        'fetchCreatedSnippets': fetchCreatedSnippetsStub,
        'insertSnippetLog': insertLogStub,
        'isPreviewUser': isPreviewUserStub,
        'fetchPreviewSnippets': previewSnippetStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST SNIPPET HANDLER FUNCTIONS ***', () => {
    const testLogId = uuid();
    const testSnippetId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockSQSBatchEvent = (event) => ({
        Records: [{ body: JSON.stringify(event) }]
    });

    beforeEach(() => helper.resetStubs(
        fetchSnippetStatusesStub, incrementStub, updateSnippetStatusStub, insertLogStub,
        createSnippetJoinStub, fetchUncreatedSnippetsStub, fetchCreatedSnippetsStub, queueEventsStub,
        isPreviewUserStub, previewSnippetStub
    ));

    it('Updates a snippets status properly, API call', async () => {      
        const mockUserSnippetJoin = {
            userId: testSystemId,
            snippetId: 'snippet-id-1',
            snippetStatus: 'FETCHED',
            viewCount: 0,
            fetchCount: 1
        };

        const mockLog = {
            userId: testSystemId,
            snippetId: 'snippet-id-1',
            logType: 'SNIPPET_VIEWED',
            logContext: {}
        };

        fetchSnippetStatusesStub.onFirstCall().resolves(mockUserSnippetJoin);

        incrementStub.resolves({ viewCount: 1, updatedTime: testUpdatedTime });
        updateSnippetStatusStub.resolves({ updatedTime: testUpdatedTime });
        insertLogStub.resolves(testLogId);

        const testEvent = {
            httpMethod: 'POST',
            requestContext: { authorizer: { systemWideUserId: testSystemId }},
            body: JSON.stringify({ snippetId: 'snippet-id-1', status: 'VIEWED' })
        };

        const resultOfUpdates = await handler.handleSnippetStatusUpdates(testEvent);

        expect(resultOfUpdates).to.deep.equal({
            statusCode: 200,
            body: JSON.stringify({ viewCount: 1 })
        });

        expect(fetchSnippetStatusesStub).to.have.been.calledOnceWithExactly(['snippet-id-1'], testSystemId);
        expect(incrementStub).to.have.been.calledOnceWithExactly('snippet-id-1', testSystemId, 'VIEWED');
        expect(updateSnippetStatusStub).to.have.been.calledOnceWithExactly('snippet-id-1', testSystemId, 'VIEWED');
        expect(insertLogStub).to.have.been.calledWithExactly(mockLog);
    });

    it('Updates a snippets status properly, SQS batch', async () => {      
        const mockUserSnippetJoinRow = (snippetId, initialStatus) => [{
            userId: testSystemId,
            snippetId,
            snippetStatus: initialStatus,
            viewCount: 0,
            fetchCount: 0,
            creationTime: testCreationTime,
            uppdatedTime: testUpdatedTime
        }];

        const mockLogObject = (snippetId) => ({
            userId: testSystemId,
            snippetId,
            logType: 'SNIPPET_VIEWED',
            logContext: {}
        });

        fetchSnippetStatusesStub.onFirstCall().resolves(mockUserSnippetJoinRow('snippet-id-1', 'FETCHED'));
        fetchSnippetStatusesStub.onSecondCall().resolves(mockUserSnippetJoinRow('snippet-id-2', 'VIEWED'));
        incrementStub.resolves({ viewCount: 2, updatedTime: testUpdatedTime });
        updateSnippetStatusStub.resolves({ updatedTime: testUpdatedTime });
        insertLogStub.resolves(testLogId);

        const testEventBatch = mockSQSBatchEvent({
            snippetIds: ['snippet-id-1', 'snippet-id-2'],
            userId: testSystemId,
            status: 'VIEWED'
        });

        const resultOfUpdates = await handler.handleSnippetStatusUpdates(testEventBatch);

        resultOfUpdates.map((result) => expect(result).to.deep.equal({
            result: 'SUCCESS',
            details: [{ viewCount: 2 }, { viewCount: 2 }]
        }));
        expect(fetchSnippetStatusesStub).to.have.been.calledWithExactly(['snippet-id-1'], testSystemId);
        expect(fetchSnippetStatusesStub).to.have.been.calledWithExactly(['snippet-id-2'], testSystemId);
        expect(incrementStub).to.have.been.calledWithExactly('snippet-id-1', testSystemId, 'VIEWED');
        expect(incrementStub).to.have.been.calledWithExactly('snippet-id-2', testSystemId, 'VIEWED');
        expect(updateSnippetStatusStub).to.have.been.calledOnceWithExactly('snippet-id-1', testSystemId, 'VIEWED');
        expect(insertLogStub).to.have.been.calledWithExactly(mockLogObject('snippet-id-1'));
        expect(insertLogStub).to.have.been.calledWithExactly(mockLogObject('snippet-id-2'));
        [fetchSnippetStatusesStub, incrementStub, insertLogStub].map((stub) => expect(stub.callCount).to.equal(2));
    });

    it('Fetches and sorts unread snippets to display to user', async () => {
        const mockSnippet = (snippetStatus, snippetPriority, viewCount) => ({
            snippetId: testSnippetId,
            title: 'Jupiter Snippet 1',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            active: true,
            viewCount,
            snippetStatus,
            snippetPriority
        });

        const mockQueueResult = {
            successCount: 2,
            failureCount: 0
        };

        const testQueueName = config.get('publishing.snippetQueue');
        const testQueuePayload = { snippetIds: [testSnippetId, testSnippetId], userId: testSystemId, status: 'FETCHED' };

        const expectedFirst = mockSnippet('FETCHED', 3, 0);
        const expectedSecond = mockSnippet('VIEWED', 5, 1);

        const mockUncreatedSnippets = [expectedSecond, expectedFirst];

        fetchUncreatedSnippetsStub.resolves(mockUncreatedSnippets);
        createSnippetJoinStub.resolves({ creationTime: testCreationTime });
        queueEventsStub.resolves(mockQueueResult);

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchSnippetsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([expectedFirst, expectedSecond]);
        expect(fetchUncreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(queueEventsStub).to.have.been.calledOnceWithExactly(testQueueName, [testQueuePayload]);
        expect(fetchCreatedSnippetsStub).to.have.not.been.called;
        expect(isPreviewUserStub).to.have.not.been.called;
        expect(previewSnippetStub).to.have.not.been.called;
    });

    it('Fetches and sorts snippets for (admin) preview', async () => {
        const mockSnippet = (snippetStatus, snippetPriority, viewCount) => ({
            snippetId: testSnippetId,
            title: 'Jupiter Snippet 2',
            body: 'Jupiter offers competetive interest rates.',
            fetchCount: 3,
            viewCount,
            snippetStatus,
            snippetPriority
        });

        const expectedFirst = mockSnippet('FETCHED', 7, 0);
        const expectedSecond = mockSnippet('VIEWED', 5, 0);
        const expectedThird = mockSnippet('VIEWED', 5, 1);

        const mockPreviewSnippets = [expectedSecond, expectedThird, expectedFirst];

        fetchUncreatedSnippetsStub.resolves([]);
        isPreviewUserStub.resolves(true);
        previewSnippetStub.resolves(mockPreviewSnippets);
        createSnippetJoinStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchSnippetsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([expectedFirst, expectedSecond, expectedThird]);
        expect(fetchUncreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(isPreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(previewSnippetStub).to.have.been.calledOnce;
        expect(fetchCreatedSnippetsStub).to.have.not.been.called;
        expect(queueEventsStub).to.have.not.been.called;
    });

    it('If no unread snippets exist, fetches and sorts previously read snippets', async () => {
        const mockSnippet = (snippetStatus, snippetPriority, viewCount) => ({
            snippetId: testSnippetId,
            title: 'Jupiter Snippet 3',
            body: 'Jupiter rewards you for saving.',
            fetchCount: 3,
            viewCount,
            snippetStatus,
            snippetPriority
        });

        const expectedFirst = mockSnippet('FETCHED', 3, 0);
        const expectedSecond = mockSnippet('VIEWED', 5, 2);

        const mockCreatedSnippets = [expectedSecond, expectedFirst];

        fetchUncreatedSnippetsStub.resolves([]);
        isPreviewUserStub.resolves(false);
        fetchCreatedSnippetsStub.resolves(mockCreatedSnippets);
        createSnippetJoinStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchSnippetsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([expectedFirst, expectedSecond]);
        expect(fetchUncreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(fetchCreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(isPreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(previewSnippetStub).to.have.not.been.called;
        expect(queueEventsStub).to.have.not.been.called;
    });

});
