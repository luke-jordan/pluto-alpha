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

const addSnippetStub = sinon.stub();
const updateSnippetStub = sinon.stub();

const fetchSnippetUserCountStub = sinon.stub();
const fetchSnippetStub = sinon.stub();
const fetchQuizSnippetStub = sinon.stub();

const countSnippetEventsStub = sinon.stub();
const insertPreviewUserStub = sinon.stub();
const removePreviewUserStub = sinon.stub();

const handler = proxyquire('../snippet-admin-handler', {
    './persistence/rds.snippets': {
        'addSnippet': addSnippetStub,
        'updateSnippet': updateSnippetStub,
        'fetchSnippetsAndUserCount': fetchSnippetUserCountStub,
        'fetchSnippetForAdmin': fetchSnippetStub,
        'fetchQuizSnippets': fetchQuizSnippetStub,
        'countSnippetEvents': countSnippetEventsStub,
        'insertPreviewUser': insertPreviewUserStub,
        'removePreviewUser': removePreviewUserStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST ADMIN SNIPPET WRITE FUNCTIONS ***', () => {
    
    const testAdminId = 'admin-usr-id';
    const testSnippetId = 'snippet-id';

    beforeEach(() => helper.resetStubs(addSnippetStub, updateSnippetStub));

    it('Happy path, creates a new snippet', async () => {
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

        addSnippetStub.resolves({ creationTime: testCreationTime.format() });

        const eventBody = {
            title: 'Jupiter Snippet 51',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const creationResult = await handler.createSnippet(testEvent);

        const body = helper.standardOkayChecks(creationResult);
        expect(body).to.deep.equal(expectedResult);
        expect(addSnippetStub).to.have.been.calledOnceWithExactly(expectedSnippet);
    });

    it('Happy path creates a snippet with questions', async () => {
        const mockTime = moment();

        const responseOptions = {
            responseTexts: [
                'As often as you like',
                'Not more than once a month',
                'Once every leap year'
            ],
            correctAnswerText: 'As often as you like'
        };
        
        const expectedResult = { result: 'SUCCESS', creationTime: mockTime.format() };

        addSnippetStub.resolves({ creationTime: mockTime.format() });

        const eventBody = {
            title: 'How often can you save?',
            body: 'Within the Jupiter App, how often are you able to save?', // actual description
            countryCode: 'ZAF',
            responseOptions
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const creationResult = await handler.createSnippet(testEvent);

        const body = helper.standardOkayChecks(creationResult);
        expect(body).to.deep.equal(expectedResult);

        const expectedSnippet = {
            createdBy: testAdminId,
            title: 'How often can you save?',
            body: 'Within the Jupiter App, how often are you able to save?',
            countryCode: 'ZAF',
            active: true,
            snippetPriority: 1,
            snippetLanguage: 'en',
            previewMode: true,
            responseOptions
        };

        expect(addSnippetStub).to.have.been.calledOnceWithExactly(expectedSnippet);
    });

    it('Happy path, updates a snippet properly', async () => {
        const testUpdatedTime = moment();

        const expectedResult = { result: 'SUCCESS', updatedTime: testUpdatedTime.format() };
        const expectedUpdateParams = {
            snippetId: testSnippetId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        updateSnippetStub.resolves({ updatedTime: testUpdatedTime.format() });

        const eventBody = {
            snippetId: testSnippetId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpdate = await handler.updateSnippet(testEvent);

        const body = helper.standardOkayChecks(resultOfUpdate);
        expect(body).to.deep.equal(expectedResult);
        expect(updateSnippetStub).to.have.been.calledOnceWithExactly(expectedUpdateParams);
    });

    it('Snippet update returns errors where called for', async () => {
        await expect(handler.updateSnippet({ httpMethod: 'POST' })).to.eventually.deep.equal({ statusCode: 403 });
        await expect(handler.updateSnippet({ })).to.eventually.deep.equal({
            statusCode: 400,
            body: `Error! 'snippetId' and a snippet property to be updated are required`
        });
        updateSnippetStub.throws(new Error('Error!'));
        const testEvent = { snippetId: testSnippetId, active: false };
        await expect(handler.updateSnippet(testEvent)).to.eventually.deep.equal(helper.wrapResponse({ error: 'Error!' }, 500));
    });

});

describe('*** UNIT TEST ADMIN SNIPPET READ FUNCTIONS ***', () => {
    const testSnippetId = uuid();
    const testAdminId = uuid();

    beforeEach(() => helper.resetStubs(fetchSnippetUserCountStub, fetchSnippetStub, countSnippetEventsStub));

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

    it('Sends shallow list of quiz snippets, for boost creation', async () => {
        const quizSnippet1 = { snippetId: 'snippet-1', title: 'Quiz Snippet 1', responseOptions: { correctAnswerText: 'Answer Here' }};
        const quizSnippet2 = { snippetId: 'snippet-2', title: 'Quiz Snippet 2', responseOptions: { correctAnswerText: 'Another Answer' }};
        
        fetchQuizSnippetStub.resolves([quizSnippet1, quizSnippet2]);

        const testEvent = helper.wrapQueryParamEvent({ onlyQuizSnippets: true }, testAdminId, 'SYSTEM_ADMIN');
        const resultOfListing = await handler.listSnippets(testEvent);

        const body = helper.standardOkayChecks(resultOfListing);
        expect(body).to.deep.equal([quizSnippet1, quizSnippet2]); // maybe in future strip response options, but not significant at present

        expect(fetchQuizSnippetStub).to.have.been.calledOnceWithExactly();
        expect(fetchSnippetUserCountStub).to.not.have.been.called;
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

});

describe('*** UNIT TEST PREVIEW USER FUNCTIONS ***', () => {
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    beforeEach(() => helper.resetStubs(insertPreviewUserStub, removePreviewUserStub));

    it('Happy path, adds a user to preview list', async () => {
        insertPreviewUserStub.resolves({ creationTime: testCreationTime });
        const testEvent = helper.wrapEvent({ systemWideUserId: testSystemId }, testAdminId, 'SYSTEM_ADMIN');
        const resultOfInsert = await handler.addUserToPreviewList(testEvent);
        const body = helper.standardOkayChecks(resultOfInsert);
        expect(body).to.deep.equal({ result: 'SUCCESS' });
        expect(insertPreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
    });

    it('Happy path, removes user from preview list', async () => {
        removePreviewUserStub.resolves({ updatedTime: testUpdatedTime });
        const testEvent = helper.wrapEvent({ systemWideUserId: testSystemId }, testAdminId, 'SYSTEM_ADMIN');
        const resultOfInsert = await handler.removeUserFromPreviewList(testEvent);
        const body = helper.standardOkayChecks(resultOfInsert);
        expect(body).to.deep.equal({ result: 'SUCCESS' });
        expect(removePreviewUserStub).to.have.been.calledOnceWithExactly(testSystemId);
    });

    it('Throws/Catches errors during addition of new preview user', async () => {
        const testEvent = helper.wrapEvent({ systemWideUserId: testSystemId }, testAdminId, 'SYSTEM_ADMIN');
        await expect(handler.addUserToPreviewList({ httpMethod: 'POST' })).to.eventually.deep.equal({ statusCode: 403 });
        const persistenceError = helper.wrapResponse({ error: 'Error inserting new preview user' }, 500);
        await expect(handler.addUserToPreviewList(testEvent)).to.eventually.deep.equal(persistenceError);
    });

    it('Throws/Catches errors on preview user removal', async () => {
        const testEvent = helper.wrapEvent({ systemWideUserId: testSystemId }, testAdminId, 'SYSTEM_ADMIN');
        await expect(handler.removeUserFromPreviewList({ httpMethod: 'POST' })).to.eventually.deep.equal({ statusCode: 403 });
        const persistenceError = helper.wrapResponse({ error: 'Error removing preview user' }, 500);
        await expect(handler.removeUserFromPreviewList(testEvent)).to.eventually.deep.equal(persistenceError);
    });
});
