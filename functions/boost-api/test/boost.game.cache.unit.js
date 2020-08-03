'use strict';

// const logger = require('debug')('jupiter:game:cache-test');

// const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();

const fetchBoostStub = sinon.stub();
const redeemOrRevokeStub = sinon.stub();

// const momentStub = sinon.stub();
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
    'ioredis': MockRedis,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

describe('*** UNIT TEST BOOST GAME CACHE OPERATIONS ***', () => {
    const testBoostId = uuid();
    const testSystemId = uuid();
    const testSessionId = uuid();

    it('Initialises game session, sets up cache', async () => {

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
        uuidStub.returns(testSessionId);

        const testEventBody = { boostId: testBoostId, eventType: 'INITIALIZE' };
        const testEvent = helper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfInit = await handler.cacheGameResponse(testEvent);

        const resultBody = helper.standardOkayChecks(resultOfInit, false);
        expect(resultBody).to.deep.equal({ sessionId: testSessionId });
    });

    it('Stores interim game results in cache', async () => {
        const testEndTime = moment().add(2, 'minutes').valueOf();
        const testCurrentTime = moment().valueOf();

        const testCachedGameState = {
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            gameEndTime: testEndTime,
            [testSessionId]: [{
                currentTime: testCurrentTime,
                currentScore: 0
            }]
        };

        redisGetStub.resolves(JSON.stringify(testCachedGameState));

        const testGameContext = {
            sessionId: testSessionId,
            currentScore: 8
        };

        const testEventBody = { boostId: testBoostId, eventType: 'GAME_IN_PROGRESS', gameLogContext: testGameContext };
        const testEvent = helper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfCache = await handler.cacheGameResponse(testEvent);

        const resultBody = helper.standardOkayChecks(resultOfCache, false);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });
    });

    // it('Consolidates final game results properly', async () => {

    // });
});
