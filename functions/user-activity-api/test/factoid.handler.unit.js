'use strict';

// const logger = require('debug')('jupiter:factoid:test');
const uuid = require('uuid/v4');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const moment = require('moment');
const helper = require('./test.helper');

const addFactStub = sinon.stub();
const fetchNewFactStub = sinon.stub();
const updateFactStub = sinon.stub();
const updatedViewedFactStub = sinon.stub();

const handler = proxyquire('../factoid-handler', {
    './persistence/rds.factoids': {
        'addFactoid': addFactStub,
        'updateFactoid': updateFactStub,
        'fetchUnviewedFactoids': fetchNewFactStub,
        'updateFactoidToViewed': updatedViewedFactStub
    },
    '@noCallThru': true
});


describe('*** UNIT TEST FACTOID HANDLER FUNCTIONS ***', () => {
    const testFactId = uuid();
    const testAdminId = uuid();
    const testSystemId = uuid();

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    it('Creates a new factoid', async () => {
        const expectedResult = { result: 'SUCCESS', creationTime: testCreationTime };
        const expectedFactoid = {
            createdBy: testAdminId,
            title: 'Jupiter Factoid 51',
            body: 'Jupiter helps you save.',
            active: true
        };

        addFactStub.resolves({ creationTime: testCreationTime });

        const eventBody = {
            title: 'Jupiter Factoid 51',
            text: 'Jupiter helps you save.'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const creationResult = await handler.createFactoid(testEvent);

        const body = helper.standardOkayChecks(creationResult);
        expect(body).to.deep.equal(expectedResult);
        expect(addFactStub).to.have.been.calledOnceWithExactly(expectedFactoid);
    });

    it('Fetches an unread factoid', async () => {
        const mockFactoid = (priority) => ({
            factoidId: testFactId,
            title: 'Jupiter Factoid 22',
            body: 'Jupiter helps you save.',
            countryCode: 'ZAF',
            factoidPriority: priority,
            responseOptions: { future: ['Options'] }
        });

        fetchNewFactStub.resolves([mockFactoid(9), mockFactoid(5)]);

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');
        const resultOfFetch = await handler.fetchFactoidForUser(testEvent);

        const body = helper.standardOkayChecks(resultOfFetch);
        expect(body).to.deep.equal(mockFactoid(9));
        expect(fetchNewFactStub).to.have.been.calledOnceWithExactly(testSystemId);
    });

    it('Fetches the oldest viewed factoid', async () => {
        // const resultOfFetch = await handler
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

    it('Marks a factoid as viewed', async () => {
        const expectedResult = { result: 'SUCCESS', updatedTime: testCreationTime };
        updatedViewedFactStub.resolves({ creationTime: testCreationTime });
        const testEvent = helper.wrapEvent({ factoidId: testFactId }, testSystemId, 'ORDINARY_USER');
        const resultOfUpdate = await handler.markFactoidViewed(testEvent);
        const body = helper.standardOkayChecks(resultOfUpdate);
        expect(body).to.deep.equal(expectedResult);
        expect(updatedViewedFactStub).to.have.been.calledOnceWithExactly(testSystemId, testFactId);
    });
});
