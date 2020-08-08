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
const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();
const redisDelStub = sinon.stub();

promisifyStub.onFirstCall().returns({ bind: () => redisDelStub });
promisifyStub.onSecondCall().returns({ bind: () => redisSetStub });
promisifyStub.onThirdCall().returns({ bind: () => redisGetStub });

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-user-handler', {
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
            // 'get': redisGetStub,
            // 'set': redisSetStub
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
    const testAccountId = uuid();
    const testSessionId = uuid();

    beforeEach(() => testHelper.resetStubs(redisGetStub, redisSetStub, fetchBoostStub, redeemOrRevokeStub, momentStub, uuidStub,
        fetchAccountStatusStub, updateBoostAccountStub, updateBoostRedeemedStub, getAccountIdForUserStub, insertBoostLogStub));

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

    it('Consolidates final game results properly, redeems when game is won', async () => {
        const gameEndTime = moment().add(2, 'minutes');
        const boostEndTime = moment().add(1, 'day');

        const gameParams = {
            gameType: 'MATCH_OBJECTS',
            timeLimitSeconds: 60,
            winningThreshold: 50,
            instructionBand: 'Select objects you have not selected before in the match',
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
        };

        const mockGameBoost = {
            boostId: testBoostId,
            label: 'Match Objects',
            boostType: 'GAME',
            boostAmount: 10000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'ZAR',
            boostEndTime,
            gameParams,
            statusConditions: {
                OFFERED: ['message_instruction_created'],
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                REDEEMED: ['number_taps_greater_than #{10::40000}']
            }
        };

        const cachedGameSession = JSON.stringify({
            boostId: testBoostId,
            systemWideUserId: testSystemId,
            gameEndTime: moment(gameEndTime.valueOf()),
            gameEvents: [
                { timestamp: moment(), numberTaps: 0 },
                { timestamp: moment(), numberTaps: 8 },
                { timestamp: moment(), numberTaps: 10 }
            ]
        });

        momentStub.returns(boostEndTime);

        redisGetStub.onFirstCall().resolves(cachedGameSession);
        redisGetStub.onSecondCall().resolves(JSON.stringify(mockGameBoost));

        getAccountIdForUserStub.resolves(testAccountId);

        fetchAccountStatusStub.resolves({ boostStatus: 'UNLOCKED' });
        redeemOrRevokeStub.resolves({ [testBoostId]: { result: 'SUCCESS' }});

        const expectedResult = { 
            result: 'TRIGGERED', 
            statusMet: ['REDEEMED'], 
            endTime: mockGameBoost.boostEndTime.valueOf(),
            amountAllocated: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'ZAR' }
        };

        const testEventBody = {
            eventType: 'USER_GAME_COMPLETION',
            boostId: testBoostId,
            sessionId: testSessionId,
            timeTakenMillis: 30000
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfCompletion = await handler.processUserBoostResponse(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOfCompletion);
        expect(resultBody).to.deep.equal(expectedResult);

        const sessionCacheKey = `${config.get('cache.prefix.gameSession')}::${testSessionId}`;
        const boostCacheKey = `${config.get('cache.prefix.gameBoost')}::${testBoostId}`;

        expect(redisGetStub).to.have.been.calledWithExactly(sessionCacheKey);
        expect(redisGetStub).to.have.been.calledWithExactly(boostCacheKey);

        const affectedAccountsDict = {
            [testBoostId]: {
                [testAccountId]: { userId: testSystemId }
            }
        };

        const redemptionArgs = {
            redemptionBoosts: [mockGameBoost],
            affectedAccountsDict,
            event: {
                accountId: testAccountId,
                eventType: 'USER_GAME_COMPLETION'
            }
        };

        expect(redeemOrRevokeStub).to.have.been.calledOnceWithExactly(redemptionArgs);
        
        const expectedLogContext = { 
            newStatus: 'REDEEMED',
            boostAmount: 10000,
            processType: 'USER',
            submittedParams: { ...testEventBody, numberTaps: 10 }
        };
        
        const expectedUpdateInstruction = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            logType: 'STATUS_CHANGE',
            logContext: expectedLogContext
        };

        const expectedGameLog = {
            boostId: testBoostId,
            accountId: testAccountId,
            logType: 'GAME_RESPONSE',
            logContext: { numberTaps: 10, timeTakenMillis: 30000 }
        };

        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedUpdateInstruction]);
        expect(insertBoostLogStub).to.have.been.calledOnceWithExactly([expectedGameLog]);
        expect(updateBoostRedeemedStub).to.have.been.calledOnceWithExactly([testBoostId]);
        
    });
});
