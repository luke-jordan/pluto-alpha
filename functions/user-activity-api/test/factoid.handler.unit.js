'use strict';

const logger = require('debug')('jupiter:factoid:test');
const uuid = require('uuid/v4');

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));
chai.use(require('chai-uuid'));

const proxyquire = require('proxyquire').noCallThru();

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
    const testAdminId = uuid();
    // const testSystemId = uuid();

    const testCreationTime = moment().format();

    it('Creates a new factoid', async () => {
        const expectedResult = { result: 'SUCCESS', creationTime: testCreationTime };
        addFactStub.resolves({ creationTime: testCreationTime });

        const eventBody = {
            text: 'Jupiter helps you save.',
            responseOptions: {}
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');

        const creationResult = await handler.createFactoid(testEvent);
        logger('Result:', creationResult);

        expect(creationResult).to.exist;
        expect(creationResult).to.have.property('statusCode', 200);
        expect(creationResult).to.have.property('body');
        expect(creationResult).to.have.property('headers');
        expect(creationResult.headers).to.deep.equal(helper.expectedHeaders);
        expect(creationResult.body).to.deep.equal(JSON.stringify(expectedResult));
    });

    // it('Updates a factoid properly', async () => {

    // });

    // it('Fetches an unread factoid', async () => {

    // });
});
