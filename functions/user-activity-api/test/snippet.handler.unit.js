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

const addFactStub = sinon.stub();
const updateFactStub = sinon.stub();
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
        'queueEvents': queueEventsStub
    },
    './persistence/rds.snippets': {
        'addSnippet': addFactStub,
        'fetchSnippetUserStatuses': fetchSnippetStatusesStub,
        'incrementCount': incrementStub,
        'updateSnippetStatus': updateSnippetStatusStub,
        'createSnippetUserJoin': createSnippetJoinStub,
        'updateSnippet': updateFactStub,
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
    const testFactId = uuid();
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockSQSBatchEvent = (event) => ({
        Records: [{ body: JSON.stringify(event) }]
    });

    beforeEach(() => helper.resetStubs(
        addFactStub, fetchSnippetStatusesStub, incrementStub, updateSnippetStatusStub,
        createSnippetJoinStub, updateFactStub, fetchUncreatedSnippetsStub, fetchCreatedSnippetsStub, queueEventsStub,
        isPreviewUserStub, previewSnippetStub
    ));

    it('Creates a new snippet', async () => {
        const expectedResult = { result: 'SUCCESS', creationTime: testCreationTime };
        const expectedSnippet = {
            createdBy: testAdminId,
            title: 'Jupiter Snippet 51',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF',
            active: true,
            snippetPriority: 1,
            snippetLanguage: 'en',
            previewMode: true
        };

        addFactStub.resolves({ creationTime: testCreationTime });

        const eventBody = {
            title: 'Jupiter Snippet 51',
            text: 'Jupiter helps you save.',
            countryCode: 'ZAF'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const creationResult = await handler.createSnippet(testEvent);

        const body = helper.standardOkayChecks(creationResult);
        expect(body).to.deep.equal(expectedResult);
        expect(addFactStub).to.have.been.calledOnceWithExactly(expectedSnippet);
    });

    it('Updates a snippets status properly', async () => {      
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

        const resultOfUpdates = await handler.handleBatchSnippetUpdates(testEventBatch);

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
            snippetId: testFactId,
            title: 'Jupiter Snippet 22',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            viewCount,
            snippetStatus,
            snippetPriority
        });

        const mockQueueResult = {
            successCount: 2,
            failureCount: 0
        };

        const expectedQueueArgs = [{
            queueName: config.get('publishing.userEvents.snippetQueue'),
            payload: { snippetIds: [testFactId, testFactId], userId: testSystemId, status: 'FETCHED' }
        }];

        const mockUncreatedSnippets = [mockSnippet('FETCHED', 3, 1), mockSnippet('FETCHED', 5, 2)];

        fetchUncreatedSnippetsStub.resolves(mockUncreatedSnippets);
        createSnippetJoinStub.resolves({ creationTime: testCreationTime });
        queueEventsStub.resolves(mockQueueResult);

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchSnippetsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockSnippet('FETCHED', 5, 2), mockSnippet('FETCHED', 3, 1)]);
        expect(fetchUncreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(queueEventsStub).to.have.been.calledOnceWithExactly(expectedQueueArgs);
        expect(fetchCreatedSnippetsStub).to.have.not.been.called;
        expect(isPreviewUserStub).to.have.not.been.called;
        expect(previewSnippetStub).to.have.not.been.called;
    });

    it('Fetches and sorts snippets for (admin) preview', async () => {
        const mockSnippet = (snippetStatus, snippetPriority, viewCount) => ({
            snippetId: testFactId,
            title: 'Jupiter Snippet 22',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            viewCount,
            snippetStatus,
            snippetPriority
        });

        const mockUncreatedSnippets = [];
        const mockPreviewSnippets = [mockSnippet('FETCHED', 3, 0), mockSnippet('VIEWED', 5, 2), mockSnippet('FETCHED', 7, 0)];

        fetchUncreatedSnippetsStub.resolves(mockUncreatedSnippets);
        isPreviewUserStub.resolves(true);
        previewSnippetStub.resolves(mockPreviewSnippets);
        createSnippetJoinStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchSnippetsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockSnippet('FETCHED', 7, 0), mockSnippet('FETCHED', 3, 0), mockSnippet('VIEWED', 5, 2)]);
        expect(fetchUncreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(isPreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(previewSnippetStub).to.have.been.calledOnce;
        expect(fetchCreatedSnippetsStub).to.have.not.been.called;
        expect(queueEventsStub).to.have.not.been.called;
    });

    it('If no unread snippets exist, fetches and sorts previously read snippets', async () => {
        const mockSnippet = (snippetStatus, snippetPriority, viewCount) => ({
            snippetId: testFactId,
            title: 'Jupiter Snippet 22',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            viewCount,
            snippetStatus,
            snippetPriority
        });

        const mockUncreatedSnippets = [];
        const mockCreatedSnippets = [mockSnippet('FETCHED', 3, 0), mockSnippet('VIEWED', 5, 2), mockSnippet('FETCHED', 7, 0), mockSnippet('VIEWED', 5, 1)];

        fetchUncreatedSnippetsStub.resolves(mockUncreatedSnippets);
        isPreviewUserStub.resolves(false);
        fetchCreatedSnippetsStub.resolves(mockCreatedSnippets);
        createSnippetJoinStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchSnippetsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockSnippet('FETCHED', 7, 0), mockSnippet('FETCHED', 3, 0), mockSnippet('VIEWED', 5, 1), mockSnippet('VIEWED', 5, 2)]);
        expect(fetchUncreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(fetchCreatedSnippetsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(isPreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(previewSnippetStub).to.have.not.been.called;
        expect(queueEventsStub).to.have.not.been.called;
    });

    it('Updates a snippet properly', async () => {
        const expectedResult = { result: 'SUCCESS', updatedTime: testUpdatedTime };
        const expectedUpdateParams = {
            snippetId: testFactId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        updateFactStub.resolves({ updatedTime: testUpdatedTime });

        const eventBody = {
            snippetId: testFactId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpdate = await handler.updateSnippet(testEvent);

        const body = helper.standardOkayChecks(resultOfUpdate);
        expect(body).to.deep.equal(expectedResult);
        expect(updateFactStub).to.have.been.calledOnceWithExactly(expectedUpdateParams);
    });
});
