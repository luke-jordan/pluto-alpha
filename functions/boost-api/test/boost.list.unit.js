'use strict';

const logger = require('debug')('jupiter:boosts:list-test');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));

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

const wrapEvent = (requestBody, systemWideUserId, role) => ({
    body: JSON.stringify(requestBody),
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
        label: '',
        active: '',
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

    // todo: add with args
    it('Lists all user boosts, active and inactive', async () => {
        fetchBoostStub.resolves([expectedBoostResult, expectedBoostResult]);
        findAccountsStub.resolves([testAccountId]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);
    });

    it('Fails on missing user id in context', async () => {
        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, null, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);
    });

    it('Fails where user account not found', async () => {
        fetchBoostStub.resolves([expectedBoostResult, expectedBoostResult]);
        findAccountsStub.resolves([]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);
    });

    it('Catches thrown errors', async () => {
        fetchBoostStub.resolves([expectedBoostResult, expectedBoostResult]);
        findAccountsStub.throws(new Error('ERROR'));

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);
    });

});