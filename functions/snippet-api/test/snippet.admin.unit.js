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

const fetchAllSnippetsStub = sinon.stub();
const fetchSnippetStub = sinon.stub();
const userCountStub = sinon.stub();
const viewCountStub = sinon.stub();
const fetchCountStub = sinon.stub();
const insertPreviewUserStub = sinon.stub();
const removePreviewUserStub = sinon.stub();

const handler = proxyquire('../snippet-admin-handler', {
    './persistence/rds.snippets': {
        'fetchAllSnippets': fetchAllSnippetsStub,
        'fetchSnippetForAdmin': fetchSnippetStub,
        'getSnippetUserCount': userCountStub,
        'getSnippetViewCount': viewCountStub,
        'getSnippetFetchCount': fetchCountStub,
        'insertPreviewUser': insertPreviewUserStub,
        'removePreviewUser': removePreviewUserStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST ADMIT SNIPPET FUNCTIONS ***', () => {
    const testSnippetId = uuid();
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    beforeEach(() => helper.resetStubs(
        fetchAllSnippetsStub, fetchSnippetStub, userCountStub, viewCountStub, fetchCountStub,
        insertPreviewUserStub, removePreviewUserStub
    ));

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
            previewMode: true
        });

        const transformedSnippet = (snippetId) => ({
            snippetId, 
            title: 'Jupiter Snippet 1',
            body: 'Jupiter is the future of saving.',
            snippetPriority: 1,
            previewMode: true
        });

        const firstSnippet = mockSnippet('snippet-id-1');
        const secondSnippet = mockSnippet('snippet-id-2');

        const expectedFirst = transformedSnippet('snippet-id-1');
        const expectedSecond = transformedSnippet('snippet-id-2');

        fetchAllSnippetsStub.resolves([firstSnippet, secondSnippet]);

        const testEvent = helper.wrapEvent({}, testAdminId, 'SYSTEM_ADMIN');
        const resultOfListing = await handler.listSnippets(testEvent);

        const body = helper.standardOkayChecks(resultOfListing);
        expect(body).to.deep.equal([expectedFirst, expectedSecond]);
        expect(fetchAllSnippetsStub).to.have.been.calledOnceWithExactly();
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
            userCount: 27,
            totalViewCount: 31,
            totalFetchCount: 40
        };

        fetchSnippetStub.resolves(mockSnippet);
        userCountStub.resolves(27);
        viewCountStub.resolves(31);
        fetchCountStub.resolves(40);

        const testEvent = helper.wrapEvent({ snippetId: testSnippetId }, testAdminId, 'SYSTEM_ADMIN');

        const resultOfFetch = await handler.viewSnippet(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal(expectedResult);
        [fetchSnippetStub, userCountStub, viewCountStub, fetchCountStub].map((stub) => expect(stub).to.have.been.calledOnceWithExactly(testSnippetId));
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
