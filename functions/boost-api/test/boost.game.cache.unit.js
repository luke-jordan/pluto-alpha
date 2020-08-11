'use strict';

// const logger = require('debug')('jupiter:game:cache-test');

const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const fetchBoostStub = sinon.stub();
const fetchAccountStatusStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();
const getAccountIdForUserStub = sinon.stub();
const insertBoostLogStub = sinon.stub();

const redeemOrRevokeStub = sinon.stub();

const momentStub = sinon.stub();
const uuidStub = sinon.stub();

const promisifyStub = sinon.stub();

const redisKeysStub = sinon.stub();
const redisMGetStub = sinon.stub();
const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();
const redisDelStub = sinon.stub();

promisifyStub.onCall(0).returns({ bind: () => redisKeysStub });
promisifyStub.onCall(1).returns({ bind: () => redisSetStub });
promisifyStub.onCall(2).returns({ bind: () => redisGetStub });
promisifyStub.onCall(3).returns({ bind: () => redisMGetStub });

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../cache-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub,
        'fetchCurrentBoostStatus': fetchAccountStatusStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        'getAccountIdForUser': getAccountIdForUserStub,
        'insertBoostAccountLogs': insertBoostLogStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redeemOrRevokeStub
    },
    'redis': {
        'createClient': () => ({
            'get': redisGetStub,
            'set': redisSetStub
        }),
        '@noCallThru': true
    },
    'util': {
        'promisify': promisifyStub
    },
    'moment': momentStub,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe('*** UNIT TEST BOOST GAME CACHE OPERATIONS ***', () => {
    const testBoostId = uuid();
    const testSystemId = uuid();
    const testSessionId = uuid();

    beforeEach(() => testHelper.resetStubs(redisGetStub, redisSetStub, fetchBoostStub, redeemOrRevokeStub, momentStub, uuidStub,
        fetchAccountStatusStub, updateBoostAccountStub, updateBoostRedeemedStub, getAccountIdForUserStub, insertBoostLogStub,
        redisDelStub, redisKeysStub));

    it('Initialises game session, sets up cache', async () => {
        const boostEndTime = moment().add(1, 'day').format();
        const testCurrentTime = moment().valueOf();
        const expectedEndTime = testCurrentTime + (60 * 1000); // time limit seconds to milliseconds

        const mockGameBoost = {
            boostId: testBoostId,
            label: 'Match Objects',
            boostType: 'GAME',
            boostEndTime,
            gameParams: {
                gameType: 'MATCH_OBJECTS',
                timeLimitSeconds: 60,
                winningThreshold: 50,
                instructionBand: 'Select objects you have not selected before in the match',
                entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
            }
        };

        redisGetStub.resolves(JSON.stringify(mockGameBoost));

        momentStub.returns({ valueOf: () => testCurrentTime });
        uuidStub.returns(testSessionId);

        const testEventBody = { boostId: testBoostId, eventType: 'INITIALISE' };
        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfInit = await handler.cacheGameResponse(testEvent);

        const resultBody = testHelper.standardOkayChecks(resultOfInit, false);
        expect(resultBody).to.deep.equal({ sessionId: testSessionId });

        const boostCacheKey = `${config.get('cache.prefix.gameBoost')}::${testBoostId}`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(boostCacheKey);

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;

        const expectedGameSession = JSON.stringify({
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            sessionId: testSessionId,
            gameEndTime: expectedEndTime,
            gameEvents: [{
                timestamp: testCurrentTime,
                numberTaps: 0
            }]
        });

        const redisSetArgs = [sessionCacheKey, expectedGameSession, 'EX', config.get('cache.ttl.gameSession')];
        expect(redisSetStub).to.have.been.calledOnceWithExactly(...redisSetArgs);
    });

    it('Stores interim game results in cache', async () => {
        const testStartTime = moment();
        const gameEndTime = testStartTime.add(2, 'minutes');
        const testCurrentTime = testStartTime.add(15, 'seconds');

        const cachedGameSession = {
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            sessionId: testSessionId,
            gameEndTime: gameEndTime.valueOf(),
            gameEvents: [{
                timestamp: testStartTime.valueOf(),
                numberTaps: 0
            }]
        };

        redisGetStub.resolves(JSON.stringify(cachedGameSession));

        momentStub.onFirstCall().returns(testCurrentTime);
        momentStub.returns({ diff: () => 21 });

        const testEventBody = {
            eventType: 'GAME_IN_PROGRESS',
            boostId: testBoostId,
            sessionId: testSessionId,
            numberTaps: 8
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');
        const resultOfCache = await handler.cacheGameResponse(testEvent);

        const resultBody = testHelper.standardOkayChecks(resultOfCache, false);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(sessionCacheKey);

        const expectedGameSession = JSON.stringify({
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            sessionId: testSessionId,
            gameEndTime: gameEndTime.valueOf(),
            gameEvents: [
                { timestamp: testStartTime.valueOf(), numberTaps: 0 },
                { timestamp: testCurrentTime.valueOf(), numberTaps: 8 }
            ]
        });

        const redisSetArgs = [sessionCacheKey, expectedGameSession, 'EX', config.get('cache.ttl.gameSession')];
        expect(redisSetStub).to.have.been.calledOnceWithExactly(...redisSetArgs);
    });

    it('Does not record suspicious game results', async () => {
        const testStartTime = moment();
        const testEndTime = testStartTime.add(2, 'minutes').valueOf();
        const testCurrentTime = testStartTime.add(5, 'milliseconds').valueOf();

        const cachedGameSession = {
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            sessionId: testSessionId,
            gameEndTime: testEndTime,
            gameEvents: [{
                timestamp: testStartTime,
                numberTaps: 0
            }]
        };

        redisGetStub.resolves(JSON.stringify(cachedGameSession));

        momentStub.returns({
            valueOf: () => testCurrentTime,
            diff: () => 0.005 // invalid min interval
        });

        const testEventBody = {
            boostId: testBoostId,
            eventType: 'GAME_IN_PROGRESS',
            sessionId: testSessionId,
            numberTaps: 13
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfCache = await handler.cacheGameResponse(testEvent);
        expect(resultOfCache).to.deep.equal({ statusCode: 400 });

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(sessionCacheKey);
        expect(redisSetStub).to.have.not.been.called;
    });

    it('Removes hanging expired games from cache', async () => {
        const gameEndTime = moment().subtract(1, 'minute');

        const mockCachedGameSession = {
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            sessionId: testSessionId,
            gameEndTime: gameEndTime.valueOf(),
            gameEvents: [
                { timestamp: moment().valueOf(), numberTaps: 0 },
                { timestamp: moment().valueOf(), numberTaps: 8 },
                { timestamp: moment().valueOf(), numberTaps: 16 }
            ]
        };

        momentStub.returns(moment());

        redisKeysStub.resolves(['some-key', `GAME_SESSION::${testSessionId}`]);
        redisMGetStub.resolves([JSON.stringify(mockCachedGameSession)]);
        redisDelStub.resolves(1);

        const resultOfExpiry = await handler.checkForHangingGame();
        expect(resultOfExpiry).to.exist;

        expect(resultOfExpiry).to.deep.equal({ result: 'SUCCESS' });
        expect(redisKeysStub).to.have.been.calledOnceWithExactly('*');
        expect(redisMGetStub).to.have.been.calledOnceWithExactly([`GAME_SESSION::${testSessionId}`]);

        const expectedGameSession = JSON.stringify({ ...mockCachedGameSession, status: 'EXPIRED' });
        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;

        const redisSetArgs = [sessionCacheKey, expectedGameSession, 'EX', config.get('cache.ttl.gameSession')];
        expect(redisSetStub).to.have.been.calledOnceWithExactly(...redisSetArgs);
    });

    it('Fetches or validates final score', async () => {

        const mockCachedGameSession = JSON.stringify({
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            sessionId: testSessionId,
            gameEndTime: moment().valueOf(),
            gameEvents: [
                { timestamp: moment().valueOf(), numberTaps: 3 },
                { timestamp: moment().valueOf(), numberTaps: 5 },
                { timestamp: moment().valueOf(), numberTaps: 8 }
            ]
        });

        redisGetStub.resolves(mockCachedGameSession);

        const resultOfFetch = await handler.fetchOrValidateFinalScore(testSessionId);
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.equal(8);

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(sessionCacheKey);

        await expect(handler.fetchOrValidateFinalScore(testSessionId, 100)).to.eventually.be.rejectedWith('Inconsistent final score');
    });
});
