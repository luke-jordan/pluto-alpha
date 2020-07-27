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

const addFactStub = sinon.stub();
const updateFactStub = sinon.stub();

const fetchSnippetUserCountStub = sinon.stub();
const fetchSnippetStub = sinon.stub();

const countSnippetEventsStub = sinon.stub();
const insertPreviewUserStub = sinon.stub();
const removePreviewUserStub = sinon.stub();

const handler = proxyquire('../snippet-admin-handler', {
    './persistence/rds.snippets': {
        'addSnippet': addFactStub,
        'updateSnippet': updateFactStub,
        'fetchSnippetsAndUserCount': fetchSnippetUserCountStub,
        'fetchSnippetForAdmin': fetchSnippetStub,
        'countSnippetEvents': countSnippetEventsStub,
        'insertPreviewUser': insertPreviewUserStub,
        'removePreviewUser': removePreviewUserStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST ADMIN SNIPPET WRITE FUNCTIONS ***', () => {
    
    const testAdminId = 'admin-usr-id';
    const testSnippetId = 'snippet-id';

    beforeEach(() => helper.resetStubs(addFactStub, updateFactStub));

    it('Creates a new snippet', async () => {
        const testCreationTime = moment();

        const expectedResult = { result: 'SUCCESS', creationTime: testCreationTime.format() };
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

        addFactStub.resolves({ creationTime: testCreationTime.format() });

        const eventBody = {
            title: 'Jupiter Snippet 51',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const creationResult = await handler.createSnippet(testEvent);

        const body = helper.standardOkayChecks(creationResult);
        expect(body).to.deep.equal(expectedResult);
        expect(addFactStub).to.have.been.calledOnceWithExactly(expectedSnippet);
    });

    it('Updates a snippet properly', async () => {
        const testUpdatedTime = moment();

        const expectedResult = { result: 'SUCCESS', updatedTime: testUpdatedTime.format() };
        const expectedUpdateParams = {
            snippetId: testSnippetId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        updateFactStub.resolves({ updatedTime: testUpdatedTime.format() });

        const eventBody = {
            snippetId: testSnippetId,
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

describe('*** UNIT TEST ADMIN SNIPPET READ FUNCTIONS ***', () => {
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

    it('Handles null on counts (if no events yet)', async () => {
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
            userCount: 0,
            totalViewCount: 0,
            totalFetchCount: 0
        };

        fetchSnippetStub.resolves(mockSnippet);
        countSnippetEventsStub.resolves(null);

        const testEvent = helper.wrapEvent({ snippetId: testSnippetId }, testAdminId, 'SYSTEM_ADMIN');

        const resultOfFetch = await handler.viewSnippet(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal(expectedResult);
        [fetchSnippetStub, countSnippetEventsStub].forEach((stub) => expect(stub).to.have.been.calledOnceWithExactly(testSnippetId));
    });

    it('Routes a read properly', async () => {
        const testEvent = (path) => ({
            httpMethod: 'GET',
            requestContext: {
                authorizer: { systemWideUserId: testAdminId, role: 'SYSTEM_ADMIN' }
            },
            pathParameters: {
                proxy: path
            }
        });

        fetchSnippetUserCountStub.resolves([]);
        const resultOfFetch = await handler.readSnippets(testEvent('list'));

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([]);

        const badEvent = await handler.readSnippets(testEvent('bad'));
        expect(badEvent.statusCode).to.equal(400);
        expect(badEvent.headers).to.deep.equal(helper.expectedHeaders);
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
