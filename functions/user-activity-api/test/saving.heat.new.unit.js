'use strict';

const moment = require('moment');
const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const proxyquire = require('proxyquire');
const { obtainPointLevels } = require('../persistence/rds.heat');

const filterEventStub = sinon.stub();
const obtainPointsStub = sinon.stub();
const insertPointLogStub = sinon.stub();

const establishUserStateStub = sinon.stub();
const updateUserStateStub = sinon.stub();

const sumPointsStub = sinon.stub();
const pointHistoryStub = sinon.stub();
const pointLevelsStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();
const redisMGetStub = sinon.stub();

const publishEventStub = sinon.stub();

const handler = proxyquire('../heat-handler', {
    './persistence/rds.heat': {
        'filterForPointRelevance': filterEventStub,
        'obtainPointsForEvent': obtainPointsStub,
        'insertPointLogs': insertPointLogStub,
        'sumPointsForUsers': sumPointsStub,
        'obtainPointHistory': pointHistoryStub,
        'obtainPointLevels': pointLevelsStub,
        'establishUserState': establishUserStateStub,
        'updateUserState': updateUserStateStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': class {
            // eslint-disable-next-line
            constructor () { this.invoke = lambdaInvokeStub; }
        },
        '@noCallThru': true
    },
    'ioredis': class {
        constructor () {
            this.get = redisGetStub;
            this.mget = redisMGetStub;
            this.set = redisSetStub;
        }
    },
    'publish-common': {
        'publishUserEvent': publishEventStub
    }
});

const resetStubs = () => helper.resetStubs(
    obtainPointsStub, insertPointLogStub, sumPointsStub, pointHistoryStub, filterEventStub, pointLevelsStub, establishUserStateStub, updateUserStateStub,
    lambdaInvokeStub, redisGetStub, redisMGetStub, redisSetStub, publishEventStub);

describe('*** USER ACTIVITY *** INSERT POINT RECORD', () => {

    const mockClientId = 'client-id';
    const mockFloatId = 'float-id';

    const wrapAsSqsBatch = (events) => ({
        Records: events.map((event) => ({ body: JSON.stringify({ Message: JSON.stringify(event) }) }))
    });

    const expectedProfileCall = (systemWideUserId) => helper.wrapLambdaInvoc('profile_fetch', false, { systemWideUserId });
    
    const mockProfileStringified = JSON.stringify({ clientId: mockClientId, floatId: mockFloatId });
    const mockProfileResult = helper.mockLambdaResponse(JSON.stringify({ body: mockProfileStringified }));
    
    const mockPair = (userId, eventType, timestamp) => ({ userId, eventType, timestamp });

    beforeEach(resetStubs);

    it('Handles single event, found, and insert points, no user cached', async () => {
        filterEventStub.resolves(['SAVING_PAYMENT_SUCCESSFUL']);
        
        redisGetStub.onFirstCall().resolves(null);
        lambdaInvokeStub.returns({ promise: () => mockProfileResult });
        redisGetStub.onSecondCall().resolves(mockProfileStringified);
        redisMGetStub.resolves([mockProfileStringified]);

        obtainPointsStub.resolves({ eventPointMatchId: 'pointJoinId', numberPoints: 7, parameters: {} });
        insertPointLogStub.resolves({ result: 'INSERTED' });

        sumPointsStub.onFirstCall().resolves({}); // last month, no events, so empty
        sumPointsStub.onSecondCall().resolves({ 'user1': 7 }); // this month
        // todo also test level extraction etc

        const mockTime = moment();
        const mockEvent = wrapAsSqsBatch([mockPair('user1', 'SAVING_PAYMENT_SUCCESSFUL', mockTime.valueOf())]);
        const resultOfHandle = await handler.handleSqsBatch(mockEvent);

        expect(resultOfHandle).to.deep.equal({ statusCode: 200, pointEventsTrigged: 1 });

        expect(filterEventStub).to.have.been.calledOnceWithExactly(['SAVING_PAYMENT_SUCCESSFUL']);

        expect(redisGetStub).to.have.been.calledWithExactly('USER_PROFILE::user1');
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedProfileCall('user1'));
        const expectedToCache = JSON.stringify({ clientId: mockClientId, floatId: mockFloatId }); // actually will have more but these relevant
        expect(redisSetStub).to.have.been.calledOnceWithExactly('USER_PROFILE::user1', expectedToCache, 'EX', 25200);

        expect(obtainPointsStub).to.have.been.calledOnceWithExactly(mockClientId, mockFloatId, 'SAVING_PAYMENT_SUCCESSFUL');
        
        // see note in code on why redundant event type here (it's for publishing logs) 
        const expectedInsertion = { eventPointMatchId: 'pointJoinId', userId: 'user1', numberPoints: 7, eventType: 'SAVING_PAYMENT_SUCCESSFUL', referenceTime: mockTime.format() };
        expect(insertPointLogStub).to.have.been.calledOnceWithExactly([expectedInsertion]);

        const expectedContext = { numberPoints: 7, awardedForEvent: 'SAVING_PAYMENT_SUCCESSFUL' }; // for the moment ; also, nb : filter out HEAT_POINTS_AWARDED on SQS sub
        expect(publishEventStub).to.have.been.calledOnceWithExactly('user1', 'HEAT_POINTS_AWARDED', { context: expectedContext });

        // todo : cover the expectations
    });

    it('Handles single event, found, insert points, user cached', async () => {
        const mockEventType = 'USER_GAME_RESPONSE';
        
        filterEventStub.resolves([mockEventType]);
        redisGetStub.resolves(mockProfileStringified);
        obtainPointsStub.resolves({ eventPointMatchId: 'pointJoinId', numberPoints: 5, parameters: {} });
        insertPointLogStub.resolves({ result: 'INSERTED' });

        const mockEvent = wrapAsSqsBatch([mockPair('userN', mockEventType)]);
        const resultOfHandle = await handler.handleSqsBatch(mockEvent);
        expect(resultOfHandle).to.exist; // rest covered above

        expect(lambdaInvokeStub).to.not.have.been.called;
        expect(redisSetStub).to.not.have.been.called;
        // rest of calls covered above
    });

    it('Handles batch events, some found, others not, mostly cached', async () => {
        const mockRefTime1 = moment();
        const mockRefTime2 = moment();

        const mockEvent = wrapAsSqsBatch([
            mockPair('user3', 'SAVING_PAYMENT_SUCCESSFUL', mockRefTime1.valueOf()),
            mockPair('userN', 'MESSAGE_SENT', mockRefTime1.valueOf()),
            mockPair('userY', 'BOOST_REDEEMED', mockRefTime2.valueOf()),
            mockPair('userF', 'USER_GAME_RESPONSE', mockRefTime2.valueOf())
        ]);

        filterEventStub.resolves(['SAVING_PAYMENT_SUCCESSFUL', 'BOOST_REDEEMED', 'USER_GAME_RESPONSE']);
        redisGetStub.withArgs('USER_PROFILE::user3').resolves(mockProfileStringified);
        lambdaInvokeStub.returns({ promise: () => mockProfileResult });
        redisGetStub.withArgs('USER_PROFILE::userY').onFirstCall().resolves(null).onSecondCall().resolves(mockProfileStringified);
        redisGetStub.withArgs('USER_PROFILE::userF').onFirstCall().resolves(null).onSecondCall().resolves(mockProfileStringified);
        
        redisMGetStub.resolves(Array(4).fill(mockProfileStringified));

        obtainPointsStub.withArgs(mockClientId, mockFloatId, 'SAVING_PAYMENT_SUCCESSFUL').resolves({ numberPoints: 10, eventPointMatchId: 'first' });
        obtainPointsStub.withArgs(mockClientId, mockFloatId, 'BOOST_REDEEMED').resolves({ numberPoints: 5, eventPointMatchId: 'second' });
        // filter is generous in that it allows to pass events that other clients may give points for (otherwise have to fetch all client-float pairs upfront)
        // so make sure handle this case
        obtainPointsStub.withArgs(mockClientId, mockFloatId, 'USER_GAME_RESPONSE').resolves(null);
        insertPointLogStub.resolves({ result: 'INSERTED' });

        sumPointsStub.onFirstCall().resolves({ 'userY': 20 });
        sumPointsStub.onSecondCall().resolves({ 'user3': 10, 'userY': 25 }); // this month

        const resultOfHandle = await handler.handleSqsBatch(mockEvent);
        expect(resultOfHandle).to.deep.equal({ statusCode: 200, pointEventsTrigged: 2 });

        expect(redisGetStub).to.have.callCount(6); // during caching, then execution
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(obtainPointsStub).to.have.been.calledThrice;
        
        const expectedFirstInsertion = { eventPointMatchId: 'first', userId: 'user3', numberPoints: 10, eventType: 'SAVING_PAYMENT_SUCCESSFUL', referenceTime: mockRefTime1.format() };
        const expectedSecondInsertion = { eventPointMatchId: 'second', userId: 'userY', numberPoints: 5, eventType: 'BOOST_REDEEMED', referenceTime: mockRefTime2.format() };
        expect(insertPointLogStub).to.have.been.calledOnceWithExactly([expectedFirstInsertion, expectedSecondInsertion]);

        expect(publishEventStub).to.have.been.calledTwice;
    });

    it('Does nothing when none found', async () => {
        filterEventStub.resolves([]);
        const mockEvent = wrapAsSqsBatch(['user1', 'user2', 'user3', 'user4'].map((userId) => mockPair(userId, 'MESSAGE_SENT')));
        const resultOfHandle = await handler.handleSqsBatch(mockEvent);
        expect(resultOfHandle).to.deep.equal({ statusCode: 200, pointEventsTrigged: 0 });
        expect(filterEventStub).to.have.been.calledOnceWithExactly(Array(4).fill('MESSAGE_SENT'));
        helper.expectNoCalls(redisGetStub, lambdaInvokeStub, redisSetStub, obtainPointsStub, insertPointLogStub, publishEventStub);
    });

});

describe('*** USER ACTIVITY *** FETCH POINTS', () => {

    beforeEach(resetStubs);

    it('Sums for single user, simple, with default dates, via API call', async () => {
        // obtaining etc is covered above, so here just stub the cache
        redisGetStub.resolves(JSON.stringify({ clientId: 'some_client', floatId: 'some_float' }));
        
        sumPointsStub.resolves({ 'user1': 105 });
        // should also test case of no levels set
        pointLevelsStub.resolves([{ minimumPoints: 50, name: 'Cold' }, { minimumPoints: 100, name: 'Hot' }]);

        const mockEvent = helper.wrapQueryParamEvent(null, 'user1');

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);
        expect(resultBody).to.deep.equal({ currentPoints: 105, currentLevel: { minimumPoints: 100, name: 'Hot' } });

        // not super happy about the nulls, but cleanest for now to retain flexibility in here
        expect(sumPointsStub).to.have.been.calledOnceWithExactly(['user1'], null, null);
        expect(pointLevelsStub).to.have.been.calledOnceWithExactly('some_client', 'some_float');
    });

    it('Sums for multiple users, specified dates', async () => {
        const mockStart = moment().subtract(30, 'days');
        const mockEnd = moment();

        const mockEvent = {
            userIds: ['user1', 'user5', 'user10'],
            startTimeMillis: mockStart.valueOf(),
            endTimeMillis: mockEnd.valueOf()
        };

        const pointSums = { 'user1': 105, 'user5': 200, 'user10': 3 }; 
        sumPointsStub.resolves(pointSums);

        const pointLevels = [{ minimumPoints: 100, name: 'Hot' }, { minimumPoints: 200, name: 'Blazing' }];
        pointLevelsStub.resolves(pointLevels);

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const { userPointMap } = resultOfHandle;
        
        expect(userPointMap).to.deep.equal({
            'user1': { currentPoints: 105, currentLevel: pointLevels[0] },
            'user5': { currentPoints: 200, currentLevel: pointLevels[1] },
            'user10': { currentPoints: 3, currentLevel: null }
        });
    });

    // not needed yet
    it.skip('Obtains a user point history', async () => {
        const mockMoments = [moment().subtract(20, 'days'), moment().subtract(5, 'days'), moment().subtract(1, 'days')];
        const mockPointHistory = [
            { creationTime: mockMoments[0], eventType: 'SAVING_PAYMENT_SUCCESSFUL', numberPoints: 10 },
            { creationTime: mockMoments[1], eventType: 'BOOST_REDEEMED', numberPoints: 5 },
            { creationTime: mockMoments[2], eventType: 'USER_GAME_RESPONSE', numberPoints: 7 }
        ];
        
        pointHistoryStub.resolves(mockPointHistory);

        const mockEvent = helper.wrapQueryParamEvent(null, 'userX');
        const resultOfHandle = await handler.fetchHeatPointRecord(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);

        const transformPointRecord = (pointRecord) => {
            pointRecord.creationTimeMillis = pointRecord.creationTime.valueOf();
            Reflect.deleteProperty(pointRecord.creationTime);
            return pointRecord;
        };

        expect(resultBody).to.deep.equal(mockPointHistory.map(transformPointRecord));
    });

});
