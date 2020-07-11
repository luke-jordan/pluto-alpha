'use strict';

// const logger = require('debug')('jupiter:snippet:test');
const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./test.helper');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const fetchSnippetUserCountStub = sinon.stub();
const fetchSnippetStub = sinon.stub();
const countSnippetEventsStub = sinon.stub();
const insertPreviewUserStub = sinon.stub();
const removePreviewUserStub = sinon.stub();

const handler = proxyquire('../snippet-admin-handler', {
    './persistence/rds.snippets': {
        'fetchSnippetsAndUserCount': fetchSnippetUserCountStub,
        'fetchSnippetForAdmin': fetchSnippetStub,
        'countSnippetEvents': countSnippetEventsStub,
        'insertPreviewUser': insertPreviewUserStub,
        'removePreviewUser': removePreviewUserStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST ADMIN SNIPPET FUNCTIONS ***', () => {
    const testSnippetId = uuid();
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    beforeEach(() => helper.resetStubs(fetchSnippetUserCountStub, fetchSnippetStub, countSnippetEventsStub, insertPreviewUserStub, removePreviewUserStub));

    it('Lists all active snippets', async () => {
        const mockSnippet = (snippetId) => ({
            snippetId,
            createdBy: testAdminId,
            title: 'Jupiter Snippet 1',
            body: 'Jupiter is the future of saving.',
            countryCode: 'ZAF',
            active: true,
            snippetPriority: 1,
            snippetLanguage: 'en',
            previewMode: true,
            userCount: 144
        });

        const transformedSnippet = (snippetId) => ({
            snippetId, 
            title: 'Jupiter Snippet 1',
            body: 'Jupiter is the future of saving.',
            snippetPriority: 1,
            previewMode: true,
            userCount: 144
        });

        const firstSnippet = mockSnippet('snippet-id-1');
        const secondSnippet = mockSnippet('snippet-id-2');

        const expectedFirst = transformedSnippet('snippet-id-1');
        const expectedSecond = transformedSnippet('snippet-id-2');

        fetchSnippetUserCountStub.resolves([firstSnippet, secondSnippet]);

        const testEvent = helper.wrapEvent({}, testAdminId, 'SYSTEM_ADMIN');
        const resultOfListing = await handler.listSnippets(testEvent);

        const body = helper.standardOkayChecks(resultOfListing);
        expect(body).to.deep.equal([expectedFirst, expectedSecond]);
        expect(fetchSnippetUserCountStub).to.have.been.calledOnceWithExactly();
    });

    it('Fetches snippet for admin', async () => {
        const mockSnippet = {
            snippetId: testSnippetId,
            createdBy: testAdminId,
            title: 'Jupiter Snippet 2',
            body: 'Jupiter positively reinforces saving for tomorrow.',
            countryCode: 'ZAF',
            active: true,
            snippetPriority: 1,
            snippetLanguage: 'en',
            previewMode: true
        };

        const expectedResult = {
            snippetId: testSnippetId,
            title: 'Jupiter Snippet 2',
            body: 'Jupiter positively reinforces saving for tomorrow.',
            userCount: 377,
            totalViewCount: 610,
            totalFetchCount: 987
        };

        fetchSnippetStub.resolves(mockSnippet);
        countSnippetEventsStub.resolves({ sumUsers: 377, sumViews: 610, sumFetches: 987 });

        const testEvent = helper.wrapEvent({ snippetId: testSnippetId }, testAdminId, 'SYSTEM_ADMIN');

        const resultOfFetch = await handler.viewSnippet(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal(expectedResult);
        [fetchSnippetStub, countSnippetEventsStub].map((stub) => expect(stub).to.have.been.calledOnceWithExactly(testSnippetId));
    });

    it('Adds a user to preview list', async () => {
        insertPreviewUserStub.resolves({ creationTime: testCreationTime });
        const testEvent = helper.wrapEvent({ systemWideUserId: testSystemId }, testAdminId, 'SYSTEM_ADMIN');
        const resultOfInsert = await handler.addUserToPreviewList(testEvent);
        const body = helper.standardOkayChecks(resultOfInsert);
        expect(body).to.deep.equal({ result: 'SUCCESS' });
        expect(insertPreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
    });

    it('Removes user from preview list', async () => {
        removePreviewUserStub.resolves({ updatedTime: testUpdatedTime });
        const testEvent = helper.wrapEvent({ systemWideUserId: testSystemId }, testAdminId, 'SYSTEM_ADMIN');
        const resultOfInsert = await handler.removeUserFromPreviewList(testEvent);
        const body = helper.standardOkayChecks(resultOfInsert);
        expect(body).to.deep.equal({ result: 'SUCCESS' });
        expect(removePreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
    });
});