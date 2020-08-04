'use strict';

const logger = require('debug')('jupiter:game:cache-test');

const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();

const fetchBoostStub = sinon.stub();
const redeemOrRevokeStub = sinon.stub();

const momentStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRedis {
    constructor () { 
        this.get = redisGetStub;
        this.set = redisSetStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-user-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redeemOrRevokeStub
    },
    'redis': {
        'createClient': {
            'get': redisGetStub,
            'set': redisSetStub
        }
    },
    'moment': momentStub,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe.only('*** UNIT TEST BOOST GAME CACHE OPERATIONS ***', () => {
    const testBoostId = uuid();
    const testSystemId = uuid();
    const testSessionId = uuid();

    beforeEach(() => testHelper.resetStubs(redisGetStub, redisSetStub, fetchBoostStub, redeemOrRevokeStub, momentStub, uuidStub));

    it('Initialises game session, sets up cache', async () => {
        const testCurrentTime = moment().valueOf();

        const mockGameBoost = {
            boostId: testBoostId,
            label: 'Match Objects',
            boostType: 'GAME',
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
        const expectedEndTime = testCurrentTime + (mockGameBoost.gameParams.timeLimitSeconds * 1000);

        const expectedGameState = JSON.stringify({
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            gameEndTime: expectedEndTime,
            [testSessionId]: [{
                timestamp: testCurrentTime,
                userScore: 0
            }]
        });

        const redisSetArgs = [sessionCacheKey, expectedGameState, 'EX', config.get('cache.ttl.gameSession')];
        expect(redisSetStub).to.have.been.calledOnceWithExactly(...redisSetArgs);
    });

    it('Stores interim game results in cache', async () => {
        const testStartTime = moment();
        const testEndTime = testStartTime.add(2, 'minutes').valueOf();
        const testCurrentTime = testStartTime.add(15, 'seconds').valueOf();

        const cachedGameState = {
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            gameEndTime: testEndTime,
            [testSessionId]: [{
                timestamp: testStartTime.valueOf(),
                userScore: 0
            }]
        };

        redisGetStub.resolves(JSON.stringify(cachedGameState));
        momentStub.returns({
            valueOf: () => testCurrentTime,
            diff: () => 21
        });

        const testEventBody = {
            boostId: testBoostId,
            eventType: 'GAME_IN_PROGRESS',
            gameLogContext: {
                sessionId: testSessionId,
                currentScore: 8
            }
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');
        const resultOfCache = await handler.cacheGameResponse(testEvent);

        const resultBody = testHelper.standardOkayChecks(resultOfCache, false);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(sessionCacheKey);

        const expectedGameState = JSON.stringify({
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            gameEndTime: testEndTime,
            [testSessionId]: [
                { timestamp: testStartTime.valueOf(), userScore: 0 },
                { timestamp: testCurrentTime, userScore: 8 },
            ]
        });

        const redisSetArgs = [sessionCacheKey, expectedGameState, 'EX', config.get('cache.ttl.gameSession')];
        expect(redisSetStub).to.have.been.calledOnceWithExactly(...redisSetArgs);
    });

    it('Does not record suspicious game results', async () => {
        const testStartTime = moment();
        const testEndTime = testStartTime.add(2, 'minutes').valueOf();
        const testCurrentTime = testStartTime.add(5, 'seconds').valueOf();

        const cachedGameState = {
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            gameEndTime: testEndTime,
            [testSessionId]: [{
                timestamp: testStartTime.valueOf(),
                userScore: 0
            }]
        };

        redisGetStub.resolves(JSON.stringify(cachedGameState));

        momentStub.returns({
            valueOf: () => testCurrentTime,
            diff: () => 5 // invalid min interval
        });

        const testEventBody = {
            boostId: testBoostId,
            eventType: 'GAME_IN_PROGRESS',
            gameLogContext: {
                sessionId: testSessionId,
                currentScore: 13
            }
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfCache = await handler.cacheGameResponse(testEvent);
        expect(resultOfCache).to.deep.equal({ statusCode: 403 });

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;
        expect(redisGetStub).to.have.been.calledOnceWithExactly(sessionCacheKey);
        expect(redisSetStub).to.have.not.been.called;
    });

    // it('Consolidates final game results properly', async () => {

    // });
});
