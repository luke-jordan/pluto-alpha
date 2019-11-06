'use strict';

const logger = require('debug')('jupiter:boosts:list-test');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./boost.test.helper');

const fetchBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();

const handler = proxyquire('../boost-list-handler', {
    './persistence/rds.admin.boost': {
        'fetchUserBoosts': fetchBoostStub,
        'findAccountsForUser': findAccountsStub
    },
    '@noCallThru': true
});

const wrapEvent = (params, systemWideUserId, role) => ({
    queryStringParameters: params,
    requestContext: {
        authorizer: {
            systemWideUserId,
            role
        }
    }
});

describe('*** UNIT TEST USER BOOST LIST HANDLER ***', () => {
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testBoostId = uuid();
    const testUserId = uuid();
    const testAccountId = uuid();

    const testStartTime = moment();
    const testEndTime = moment().add(1, 'week');

    const expectedBoostResult = {
        boostId: testBoostId,
        creatingUserId: '',
        label: 'BOOST LABEL',
        active: true,
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostRedeemed: 600000,
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        startTime: testStartTime.format(),
        endTime: testEndTime.format(),
        statusConditions: testStatusCondition,
        initialStatus: 'PENDING',
    };

    beforeEach(() => {
        helper.resetStubs(fetchBoostStub, findAccountsStub);
    });

    it('Lists all user boosts, active and inactive', async () => {
        fetchBoostStub.withArgs(testAccountId).resolves([expectedBoostResult, expectedBoostResult]);
        findAccountsStub.resolves([testAccountId]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 200);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify([expectedBoostResult, expectedBoostResult]));
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

    it('Handles dry run', async () => {
        fetchBoostStub.withArgs(testAccountId).resolves([expectedBoostResult, expectedBoostResult]);
        findAccountsStub.resolves([testAccountId]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({dryRun: true}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 200);
        expect(resultOfListing.body).to.exist;
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(fetchBoostStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.not.been.called;
    });

    it('Fails on missing user id in context', async () => {
        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, null, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 403);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify({ message: 'User ID not found in context' }));
        expect(fetchBoostStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.not.been.called;
    });

    it('Fails where user account not found', async () => {
        findAccountsStub.resolves([]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 403);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify({ message: 'No account found for this user' }));
        expect(fetchBoostStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

    it('Catches thrown errors', async () => {
        findAccountsStub.throws(new Error('ERROR'));

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 500);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify({ error: 'ERROR' }));
        expect(fetchBoostStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

});