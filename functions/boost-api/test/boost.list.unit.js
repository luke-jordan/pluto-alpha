'use strict';

const logger = require('debug')('jupiter:boosts:list:test');
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
const fetchBoostLogsStub = sinon.stub();

const handler = proxyquire('../boost-list-handler', {
    './persistence/rds.boost.list': {
        'fetchUserBoosts': fetchBoostStub,
        'findAccountsForUser': findAccountsStub,
        'fetchUserBoostLogs': fetchBoostLogsStub,
        '@noCallThru': true
    },
    '@noCallThru': true
});

const wrapEvent = (params, systemWideUserId, role) => ({
    httpMethod: 'GET',
    queryStringParameters: params,
    requestContext: {
        authorizer: { systemWideUserId, role }
    }
});

describe('*** UNIT TEST USER BOOST LIST HANDLER ***', () => {
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testBoostId = uuid();
    const testUserId = uuid();
    const testAccountId = uuid();

    const testStartTime = moment();
    const testEndTime = moment().add(1, 'week');

    const mockBoostFromRds = {
        boostId: testBoostId,
        creatingUserId: '',
        label: 'BOOST LABEL',
        active: true,
        boostType: 'SIMPLE',
        boostCategory: 'SIMPLE_SAVE',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostRedeemed: 600000,
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        startTime: testStartTime.format(),
        endTime: testEndTime.format(),
        statusConditions: testStatusCondition,
        boostStatus: 'OFFERED'
    };

    const expectedBoostToUser = {
        ...mockBoostFromRds,
        boostAmount: 10,
        boostUnit: 'WHOLE_CURRENCY'
    };

    beforeEach(() => {
        helper.resetStubs(fetchBoostStub, findAccountsStub, fetchBoostLogsStub);
    });

    it('Lists all user boosts, active and inactive', async () => {
        fetchBoostStub.withArgs(testAccountId).resolves([mockBoostFromRds, mockBoostFromRds]);
        findAccountsStub.resolves([testAccountId]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        const resultBody = helper.standardOkayChecks(resultOfListing, true);
        expect(resultBody).to.deep.equal([mockBoostFromRds, mockBoostFromRds]);
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(fetchBoostLogsStub).to.not.have.been.called;
    });

    it('Lists all active boosts with flag', async () => {
        const excludedStatus = ['REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED']; // starting to grandfather in FAILED
        findAccountsStub.resolves([testAccountId]);
        fetchBoostStub.resolves([mockBoostFromRds]); // not relevant to test

        const resultOfListing = await handler.listUserBoosts(wrapEvent({ flag: 'FRIEND_TOURNAMENT', onlyActive: true }, testUserId));
        
        const bodyOfResult = helper.standardOkayChecks(resultOfListing);
        expect(bodyOfResult).to.deep.equal([mockBoostFromRds]);

        expect(fetchBoostStub).to.have.been.calledOnce;
        expect(fetchBoostStub).to.have.been.calledWith(testAccountId, { flags: ['FRIEND_TOURNAMENT'], excludedStatus });
    });

    it('Checks for boosts with recently changed status', async () => {
        const expiredBoostResult = { ...mockBoostFromRds };
        expiredBoostResult.boostStatus = 'EXPIRED';
        expiredBoostResult.boostUnit = 'WHOLE_CURRENCY';
        expiredBoostResult.boostAmount = 10;

        findAccountsStub.resolves([testAccountId]);
        fetchBoostStub.onFirstCall().resolves([mockBoostFromRds]);
        fetchBoostStub.onSecondCall().resolves([expiredBoostResult]);

        const resultOfChangeFetch = await handler.listChangedBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        const resultBody = helper.standardOkayChecks(resultOfChangeFetch);
        logger('Result body: ', resultBody);

        expect(resultBody).to.deep.equal([expectedBoostToUser, expiredBoostResult]);
        
        expect(fetchBoostStub).to.have.been.calledWith(testAccountId, { changedSinceTime: sinon.match.any, excludedStatus: ['CREATED', 'OFFERED', 'EXPIRED'] });
        expect(fetchBoostStub).to.have.been.calledWith(testAccountId, { changedSinceTime: sinon.match.any, excludedStatus: ['CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED'] });

        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(fetchBoostLogsStub).to.not.have.been.called;
    });

    it('Attach game outcome result to game logs, won tournament', async () => {
        const gameBoost = { ...mockBoostFromRds };
        gameBoost.boostType = 'GAME';
        gameBoost.boostStatus = 'REDEEMED';

        findAccountsStub.resolves([testAccountId]);
        fetchBoostStub.onFirstCall().resolves([gameBoost]);
        fetchBoostStub.onSecondCall().resolves([]);

        const mockLockContext = { numberTaps: 10, ranking: 1 };
        const mockGameLog = { accountId: testAccountId, boostId: testBoostId, logType: 'GAME_OUTCOME', logContext: mockLockContext };
        fetchBoostLogsStub.resolves([mockGameLog]);

        const resultOfChangeFetch = await handler.listChangedBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        const bodyOfResult = helper.standardOkayChecks(resultOfChangeFetch);

        const expectedBoost = { ...expectedBoostToUser, boostType: 'GAME', boostStatus: 'REDEEMED', gameLogs: [mockGameLog] }; 
        const fetchedBoost = bodyOfResult[0];
        expect(fetchedBoost).to.deep.equal(expectedBoost);

        expect(fetchBoostLogsStub).to.have.been.calledOnceWithExactly(testAccountId, [testBoostId], 'GAME_OUTCOME');
    });

    it('Attach game outcome result to game logs, lost tournament', async () => {
        const gameBoost = { ...mockBoostFromRds };
        gameBoost.boostType = 'GAME';
        gameBoost.boostStatus = 'EXPIRED';

        findAccountsStub.resolves([testAccountId]);
        fetchBoostStub.onFirstCall().resolves([]);
        fetchBoostStub.onSecondCall().resolves([gameBoost]);

        const mockLockContext = { numberTaps: 3, ranking: 4 };
        const mockGameLog = { accountId: testAccountId, boostId: testBoostId, logType: 'GAME_OUTCOME', logContext: mockLockContext };
        fetchBoostLogsStub.resolves([mockGameLog]);

        const resultOfChangeFetch = await handler.listChangedBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        const bodyOfResult = helper.standardOkayChecks(resultOfChangeFetch);

        const expectedBoost = { ...expectedBoostToUser, boostType: 'GAME', boostStatus: 'EXPIRED', gameLogs: [mockGameLog] }; 
        const fetchedBoost = bodyOfResult[0];
        expect(fetchedBoost).to.deep.equal(expectedBoost);

        expect(fetchBoostLogsStub).to.have.been.calledOnceWithExactly(testAccountId, [testBoostId], 'GAME_OUTCOME');
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
