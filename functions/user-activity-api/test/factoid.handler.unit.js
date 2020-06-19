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
const pushFactoidStub = sinon.stub();
const fetchUnviewedFactoidsStub = sinon.stub();
const fetchViewedFactoidsStub = sinon.stub();
const incrementStub = sinon.stub();
const updateFactoidStatusStub = sinon.stub();
const fetchFactoidDetailStub = sinon.stub();

const handler = proxyquire('../factoid-handler', {
    './persistence/rds.factoids': {
        'addFactoid': addFactStub,
        'fetchFactoidDetails': fetchFactoidDetailStub,
        'incrementCount': incrementStub,
        'updateFactoidStatus': updateFactoidStatusStub,
        'pushFactoidToUser': pushFactoidStub,
        'updateFactoid': updateFactStub,
        'fetchUnviewedFactoids': fetchUnviewedFactoidsStub,
        'fetchViewedFactoids': fetchViewedFactoidsStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST FACTOID HANDLER FUNCTIONS ***', () => {
    const testFactId = uuid();
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockSQSBatchEvent = (event) => ({
        Records: [
            { body: JSON.stringify(event) },
            { body: JSON.stringify(event) },
            { body: JSON.stringify(event) },
            { body: JSON.stringify(event) }
        ]
    });

    beforeEach(() => helper.resetStubs(addFactStub, fetchFactoidDetailStub, incrementStub, updateFactoidStatusStub,
        pushFactoidStub, updateFactStub, fetchUnviewedFactoidsStub, fetchViewedFactoidsStub) )

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
        
        const mockFactoidRef = {
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: 'PUSHED',
            readCount: 0,
            creationTime: testCreationTime,
            uppdatedTime: testUpdatedTime
        };

        fetchFactoidDetailStub.resolves([mockFactoidRef]);
        incrementStub.resolves({ updatedTime: testUpdatedTime });
        updateFactoidStatusStub.resolves({ updatedTime: testUpdatedTime });

        const testEventBatch = mockSQSBatchEvent({
            factoidIds: [testFactId, testFactId],
            userId: testSystemId,
            status: 'VIEWED'
        });

        const resultOfUpdates = await handler.handleBatchFactoidUpdates(testEventBatch);
        logger('Result:', resultOfUpdates)

        resultOfUpdates.map((result) => {
            const body = helper.standardOkayChecks(result);
            expect(body).to.deep.equal(expectedResult);
        });
        expect(fetchFactoidDetailStub).to.have.been.calledWithExactly([testFactId], testSystemId);
        expect(incrementStub).to.have.been.calledWithExactly(testFactId, testSystemId, 'VIEWED');
        expect(updateFactoidStatusStub).to.have.been.calledWithExactly(testFactId, testSystemId, 'VIEWED');
        [fetchFactoidDetailStub, incrementStub, updateFactoidStatusStub].map((stub) => expect(stub.callCount).to.equal(8));
    });

    it('Fetches an unread factoid properly', async () => {
        const mockFactoid = (priority, creationTime = testCreationTime) => ({
            factoidId: testFactId,
            title: 'Jupiter Factoid 22',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF',
            factoidPriority: priority,
            creationTime
        });

        const mockFactoidDetails = {
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: 'PUSHED',
            readCount: 0,
            fetchCount: 0,
            creationTime: testCreationTime,
            updatedTime: testUpdatedTime
        };

        fetchFactoidDetailStub.onFirstCall().resolves([]);
        fetchFactoidDetailStub.onSecondCall().resolves([]);
        fetchFactoidDetailStub.resolves([mockFactoidDetails, mockFactoidDetails]);
        fetchUnviewedFactoidsStub.resolves([mockFactoid(5), mockFactoid(9)]);
        pushFactoidStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchFactoidsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockFactoid(9), mockFactoid(5)]);
        expect(fetchUnviewedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(fetchFactoidDetailStub).to.have.been.calledWithExactly([testFactId, testFactId], testSystemId);
        expect(fetchFactoidDetailStub).to.have.been.calledThrice;
        expect(pushFactoidStub).to.have.been.calledWithExactly(testFactId, testSystemId);
        expect(pushFactoidStub).to.have.been.calledTwice;
        expect(fetchViewedFactoidsStub).to.have.not.been.called;
    });

    it('Fetches previously viewed factoids properly', async () => {
        const mockFactoid = {
            factoidId: testFactId,
            title: 'Jupiter Factoid 45',
            body: 'Jupiter rewards you for saving.',
            countryCode: 'ZAF',
            factoidPriority: 1,
            creationTime: testCreationTime
        };

        const mockFactoidDetails = (readCount, updatedTime) => ({
            userId: testSystemId,
            factoidId: testFactId,
            factoidStatus: 'VIEWED',
            readCount,
            fetchCount: 0,
            creationTime: testCreationTime,
            updatedTime
        });

        const testTime1 = moment().format();
        const testTime2 = moment().format();
        const [mockFactoid1, mockFactoid2] = [mockFactoidDetails(2, testTime1), mockFactoidDetails(1, testTime2)];

        fetchFactoidDetailStub.resolves([mockFactoid1, mockFactoid2]);
        fetchUnviewedFactoidsStub.resolves([]);
        fetchViewedFactoidsStub.resolves([mockFactoid, mockFactoid]);
        pushFactoidStub.resolves({ creationTime: testCreationTime });

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchFactoidsForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal([mockFactoid, mockFactoid]);
        expect(fetchUnviewedFactoidsStub).to.have.been.calledOnceWithExactly(testSystemId);
        expect(fetchFactoidDetailStub).to.have.been.calledOnceWithExactly([testFactId, testFactId], testSystemId);
        expect(pushFactoidStub).to.have.not.been.called;
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
