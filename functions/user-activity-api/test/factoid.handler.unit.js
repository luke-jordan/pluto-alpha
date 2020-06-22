'use strict';

const logger = require('debug')('jupiter:factoid:test');
const uuid = require('uuid/v4');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const moment = require('moment');
const helper = require('./test.helper');
const { updateFactoidStateForUser } = require('../factoid-handler');

const addFactStub = sinon.stub();
const updateFactStub = sinon.stub();
const createFactoidJoinStub = sinon.stub();
const fetchUncreatedFactoidsStub = sinon.stub();
const fetchCreatedFactoidsStub = sinon.stub();
const incrementStub = sinon.stub();
const updateFactoidStatusStub = sinon.stub();
const fetchFactoidStatusesStub = sinon.stub();
const sqsSendStub = sinon.stub();
const getQueueUrlStub = sinon.stub();

class MockSQSClient {
    constructor () { 
        this.sendMessage = sqsSendStub; 
        this.getQueueUrl = getQueueUrlStub;
    }
}

const handler = proxyquire('../factoid-handler', {
    'aws-sdk': {
        'SQS': MockSQSClient,
        // eslint-disable-next-line no-empty-function
        'config': { update: () => ({}) }
    },
    './persistence/rds.factoids': {
        'addFactoid': addFactStub,
        'fetchFactoidUserStatuses': fetchFactoidStatusesStub,
        'incrementCount': incrementStub,
        'updateFactoidStatus': updateFactoidStatusStub,
        'createFactoidUserJoin': createFactoidJoinStub,
        'updateFactoid': updateFactStub,
        'fetchUncreatedFactoids': fetchUncreatedFactoidsStub,
        'fetchCreatedFactoids': fetchCreatedFactoidsStub
    },
    '@noCallThru': true
});

describe.only('*** UNIT TEST FACTOID HANDLER FUNCTIONS ***', () => {
    const testFactId = uuid();
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockSQSBatchEvent = (event) => ({
        Records: [{ body: JSON.stringify(event) }]
    });

    const mockSQSResponse = {
        ResponseMetadata: { RequestId: uuid() },
        MD5OfMessageBody: uuid(),
        MD5OfMessageAttributes: uuid(),
        MessageId: uuid()
    };

    beforeEach(() => helper.resetStubs(addFactStub, fetchFactoidStatusesStub, incrementStub, updateFactoidStatusStub,
        createFactoidJoinStub, updateFactStub, fetchUncreatedFactoidsStub, fetchCreatedFactoidsStub, getQueueUrlStub, sqsSendStub));

    it('Creates a new factoid', async () => {
        const expectedResult = { result: 'SUCCESS', creationTime: testCreationTime };
        const expectedFactoid = {
            createdBy: testAdminId,
            title: 'Jupiter Factoid 51',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF',
            active: true
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
        const expectedResultPerFactoid = {
            result: 'VIEWED',
            factoidId: testFactId,
            details: { updatedTime: testUpdatedTime }
        };

        const expectedResult = {
            result: 'SUCCESS',
            details: [expectedResultPerFactoid, expectedResultPerFactoid]
        };
        
        const mockUserFactoidJoinRow = (initialStatus) => [{
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: initialStatus,
            viewCount: 0,
            creationTime: testCreationTime,
            uppdatedTime: testUpdatedTime
        }];

        fetchFactoidStatusesStub.onCall(0).resolves(mockUserFactoidJoinRow('UNCREATED'));
        fetchFactoidStatusesStub.onCall(1).resolves(mockUserFactoidJoinRow('CREATED'));
        fetchFactoidStatusesStub.onCall(2).resolves(mockUserFactoidJoinRow('PUSHED'));
        fetchFactoidStatusesStub.onCall(3).resolves(mockUserFactoidJoinRow('VIEWED'));
        incrementStub.resolves({ viewCount: 2, updatedTime: testUpdatedTime });
        updateFactoidStatusStub.resolves({ updatedTime: testUpdatedTime });

        const testEventBatch = mockSQSBatchEvent({
            factoidIds: [testFactId, testFactId, testFactId, testFactId],
            userId: testSystemId,
            status: 'VIEWED'
        });

        const resultOfUpdates = await handler.handleBatchFactoidUpdates(testEventBatch);
        logger('Result:', resultOfUpdates)

        resultOfUpdates.map((result) => {
            expect(result).to.deep.equal({
                result: 'SUCCESS',
                details: [{ viewCount: 2 }, { viewCount: 2 }, { viewCount: 2 }, { viewCount: 2 }]
            });
        });
        expect(fetchFactoidStatusesStub).to.have.been.calledWithExactly([testFactId], testSystemId);
        expect(incrementStub).to.have.been.calledWithExactly(testFactId, testSystemId, 'VIEWED');
        expect(updateFactoidStatusStub).to.have.been.calledWithExactly(testFactId, testSystemId, 'VIEWED');
        [fetchFactoidStatusesStub, incrementStub].map((stub) => expect(stub.callCount).to.equal(4));
        expect(updateFactoidStatusStub.callCount).to.equal(3);
    });

    it('Fetches factoids properly', async () => {
        const mockFactoid = (status, factoidPriority, viewCount) => ({
            factoidId: testFactId,
            title: 'Jupiter Factoid 22',
            body: 'Jupiter helps you save.',
            fetchCount: 3,
            viewCount: viewCount,
            factoidStatus: status,
            factoidPriority
        });

        const mockUncreatedFactoids = [mockFactoid('UNCREATED', 1, 0), mockFactoid('UNCREATED', 1, 0)];
        const mockCreatedFactoids = [mockFactoid('PUSHED', 3, 0), mockFactoid('VIEWED', 5, 2), mockFactoid('PUSHED', 7, 0), mockFactoid('VIEWED', 5, 1)];

        fetchFactoidStatusesStub.onFirstCall().resolves([]);
        fetchFactoidStatusesStub.onSecondCall().resolves([]);
        fetchUncreatedFactoidsStub.resolves(mockUncreatedFactoids);
        fetchCreatedFactoidsStub.resolves(mockCreatedFactoids);
        createFactoidJoinStub.resolves({ creationTime: testCreationTime });
        getQueueUrlStub.returns({ promise: () => ({ QueueUrl: 'queue/url' })});
        sqsSendStub.returns({ promise: () => mockSQSResponse });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchFactoidsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockFactoid('PUSHED', 7, 0), mockFactoid('PUSHED', 3, 0), mockFactoid('VIEWED', 5, 1), mockFactoid('VIEWED', 5, 2)]);
        expect(fetchUncreatedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(fetchCreatedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(getQueueUrlStub).to.have.been.calledOnce;
        expect(sqsSendStub).to.have.been.calledOnce;
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
