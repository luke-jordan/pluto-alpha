'use strict';

// const logger = require('debug')('jupiter:factoid:test');
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
const createFactoidJoinStub = sinon.stub();
const fetchUncreatedFactoidsStub = sinon.stub();
const fetchCreatedFactoidsStub = sinon.stub();
const incrementStub = sinon.stub();
const updateFactoidStatusStub = sinon.stub();
const fetchFactoidStatusesStub = sinon.stub();
const queueEventsStub = sinon.stub();
const insertLogStub = sinon.stub();

const handler = proxyquire('../factoid-handler', {
    'publish-common': {
        'queueEvents': queueEventsStub
    },
    './persistence/rds.factoids': {
        'addFactoid': addFactStub,
        'fetchFactoidUserStatuses': fetchFactoidStatusesStub,
        'incrementCount': incrementStub,
        'updateFactoidStatus': updateFactoidStatusStub,
        'createFactoidUserJoin': createFactoidJoinStub,
        'updateFactoid': updateFactStub,
        'fetchUncreatedFactoids': fetchUncreatedFactoidsStub,
        'fetchCreatedFactoids': fetchCreatedFactoidsStub,
        'insertFactoidLog': insertLogStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST FACTOID HANDLER FUNCTIONS ***', () => {
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
        addFactStub, fetchFactoidStatusesStub, incrementStub, updateFactoidStatusStub,
        createFactoidJoinStub, updateFactStub, fetchUncreatedFactoidsStub, fetchCreatedFactoidsStub, queueEventsStub
    ));

    it('Creates a new factoid', async () => {
        const expectedResult = { result: 'SUCCESS', creationTime: testCreationTime };
        const expectedFactoid = {
            createdBy: testAdminId,
            title: 'Jupiter Factoid 51',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF',
            active: true,
            factoidPriority: 1
        };

        addFactStub.resolves({ creationTime: testCreationTime });

        const eventBody = {
            title: 'Jupiter Factoid 51',
            text: 'Jupiter helps you save.',
            countryCode: 'ZAF'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const creationResult = await handler.createFactoid(testEvent);

        const body = helper.standardOkayChecks(creationResult);
        expect(body).to.deep.equal(expectedResult);
        expect(addFactStub).to.have.been.calledOnceWithExactly(expectedFactoid);
    });

    it('Updates a factoids status properly', async () => {      
        const mockUserFactoidJoinRow = (factoidId, initialStatus) => [{
            userId: testSystemId,
            factoidId,
            factoidStatus: initialStatus,
            viewCount: 0,
            fetchCount: 0,
            creationTime: testCreationTime,
            uppdatedTime: testUpdatedTime
        }];

        const mockLogObject = (factoidId) => ({
            userId: testSystemId,
            factoidId,
            logType: 'FACTOID_VIEWED',
            logContext: {}
        });

        fetchFactoidStatusesStub.onFirstCall().resolves(mockUserFactoidJoinRow('factoid-id-1', 'FETCHED'));
        fetchFactoidStatusesStub.onSecondCall().resolves(mockUserFactoidJoinRow('factoid-id-2', 'VIEWED'));
        incrementStub.resolves({ viewCount: 2, updatedTime: testUpdatedTime });
        updateFactoidStatusStub.resolves({ updatedTime: testUpdatedTime });
        insertLogStub.resolves(testLogId);

        const testEventBatch = mockSQSBatchEvent({
            factoidIds: ['factoid-id-1', 'factoid-id-2'],
            userId: testSystemId,
            status: 'VIEWED'
        });

        const resultOfUpdates = await handler.handleBatchFactoidUpdates(testEventBatch);

        resultOfUpdates.map((result) => expect(result).to.deep.equal({
            result: 'SUCCESS',
            details: [{ viewCount: 2 }, { viewCount: 2 }]
        }));
        expect(fetchFactoidStatusesStub).to.have.been.calledWithExactly(['factoid-id-1'], testSystemId);
        expect(fetchFactoidStatusesStub).to.have.been.calledWithExactly(['factoid-id-2'], testSystemId);
        expect(incrementStub).to.have.been.calledWithExactly('factoid-id-1', testSystemId, 'VIEWED');
        expect(incrementStub).to.have.been.calledWithExactly('factoid-id-2', testSystemId, 'VIEWED');
        expect(updateFactoidStatusStub).to.have.been.calledOnceWithExactly('factoid-id-1', testSystemId, 'VIEWED');
        expect(insertLogStub).to.have.been.calledWithExactly(mockLogObject('factoid-id-1'));
        expect(insertLogStub).to.have.been.calledWithExactly(mockLogObject('factoid-id-2'));
        [fetchFactoidStatusesStub, incrementStub, insertLogStub].map((stub) => expect(stub.callCount).to.equal(2));
    });

    it('Fetches and sorts unread factoids to display to a user', async () => {
        const mockFactoid = (factoidStatus, factoidPriority, viewCount) => ({
            factoidId: testFactId,
            title: 'Jupiter Factoid 22',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            viewCount,
            factoidStatus,
            factoidPriority
        });

        const mockQueueResult = {
            successCount: 2,
            failureCount: 0
        };

        const expectedQueueArgs = [{
            queueName: config.get('publishing.userEvents.factoidQueue'),
            payload: { factoidIds: [testFactId, testFactId], userId: testSystemId, status: 'FETCHED' }
        }];

        const mockUncreatedFactoids = [mockFactoid('FETCHED', 3, 1), mockFactoid('FETCHED', 5, 2)];

        fetchUncreatedFactoidsStub.resolves(mockUncreatedFactoids);
        createFactoidJoinStub.resolves({ creationTime: testCreationTime });
        queueEventsStub.resolves(mockQueueResult);

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchFactoidsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockFactoid('FETCHED', 5, 2), mockFactoid('FETCHED', 3, 1)]);
        expect(fetchUncreatedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(queueEventsStub).to.have.been.calledOnceWithExactly(expectedQueueArgs);
        expect(fetchCreatedFactoidsStub).to.have.not.been.called;
    });

    it('If no unread factoids exist, fetches and sorts previously read factoids', async () => {
        const mockFactoid = (factoidStatus, factoidPriority, viewCount) => ({
            factoidId: testFactId,
            title: 'Jupiter Factoid 22',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            viewCount,
            factoidStatus,
            factoidPriority
        });

        const mockUncreatedFactoids = [];
        const mockCreatedFactoids = [mockFactoid('FETCHED', 3, 0), mockFactoid('VIEWED', 5, 2), mockFactoid('FETCHED', 7, 0), mockFactoid('VIEWED', 5, 1)];

        fetchUncreatedFactoidsStub.resolves(mockUncreatedFactoids);
        fetchCreatedFactoidsStub.resolves(mockCreatedFactoids);
        createFactoidJoinStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchFactoidsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockFactoid('FETCHED', 7, 0), mockFactoid('FETCHED', 3, 0), mockFactoid('VIEWED', 5, 1), mockFactoid('VIEWED', 5, 2)]);
        expect(fetchUncreatedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(fetchCreatedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(queueEventsStub).to.have.not.been.called;
    });

    it('Updates a factoid properly', async () => {
        const expectedResult = { result: 'SUCCESS', updatedTime: testUpdatedTime };
        const expectedUpdateParams = {
            factoidId: testFactId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        updateFactStub.resolves({ updatedTime: testUpdatedTime });

        const eventBody = {
            factoidId: testFactId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpdate = await handler.updateFactoid(testEvent);

        const body = helper.standardOkayChecks(resultOfUpdate);
        expect(body).to.deep.equal(expectedResult);
        expect(updateFactStub).to.have.been.calledOnceWithExactly(expectedUpdateParams);
    });
});
