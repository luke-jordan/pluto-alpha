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
const updateFactStub = sinon.stub();
const fetchFactStub = sinon.stub();

const handler = proxyquire('../factoid-handler', {
    './persistence/rds': {
        'addFactoid': addFactStub,
        'updateFactoid': updateFactStub,
        'fetchUnreadFactoid': fetchFactStub
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

        expect(creationResult).to.exist;
        expect(creationResult).to.have.property('statusCode', 200);
        expect(creationResult).to.have.property('body');
        expect(creationResult).to.have.property('headers');
        expect(creationResult.headers).to.deep.equal(helper.expectedHeaders);
        expect(creationResult.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(addFactStub).to.have.been.calledOnceWithExactly(expectedFactoid);
    });

    it('Updates a factoid properly', async () => {
        const expectedResult = { result: 'SUCCESS', updatedTime: testUpdatedTime };
        const expectedUpdateParams = {
            factoidId: testFactId,
            active: true,
            body: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        updateFactStub.resolves({ updatedTime: testUpdatedTime })

        const eventBody = {
            factoidId: testFactId,
            active: true,
            text: 'Jupiter gives you an annual interest rate of up to 5%.'
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');

        const resultOfUpdate = await handler.updateFactoid(testEvent);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.have.property('statusCode', 200);
        expect(resultOfUpdate).to.have.property('body');
        expect(resultOfUpdate).to.have.property('headers');
        expect(resultOfUpdate.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfUpdate.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(updateFactStub).to.have.been.calledOnceWithExactly(expectedUpdateParams);
    });

    it('Fetches an unread factoid', async () => {
        const testFactoid = {
            factoidId: testFactId,
            title: 'Jupiter Factoid 22',
            body: 'Jupiter helps you save.',
            responseOptions: { future: ['Options'] }
        };

        fetchFactStub.resolves(testFactoid);

        const testEvent = helper.wrapQueryParamEvent({}, testSystemId, 'GET');

        const resultOfFetch = await handler.fetchFactoidForUser(testEvent);

        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.have.property('statusCode', 200);
        expect(resultOfFetch).to.have.property('body');
        expect(resultOfFetch).to.have.property('headers');
        expect(resultOfFetch.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfFetch.body).to.deep.equal(JSON.stringify(testFactoid));
        expect(fetchFactStub).to.have.been.calledOnceWithExactly(testSystemId);
    });
});
