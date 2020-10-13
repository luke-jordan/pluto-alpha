'use strict';


// const logger = require('debug')('jupiter:heat:test');
const moment = require('moment');

const uuid = require('uuid/v4');
const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const { expect } = chai;

const proxyquire = require('proxyquire');

const filterEventStub = sinon.stub();
const obtainPointsStub = sinon.stub();
const insertPointLogStub = sinon.stub();

const establishUserStateStub = sinon.stub();
const updateUserStateStub = sinon.stub();

const obtainStateUsersStub = sinon.stub();
const obtainUserLevelStub = sinon.stub();
const obtainActivitiesStub = sinon.stub();
const fetchUserLevelStub = sinon.stub();

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
        'obtainAllUsersWithState': obtainStateUsersStub,
        'obtainUserLevels': obtainUserLevelStub,
        'obtainLatestActivities': obtainActivitiesStub,
        'fetchUserLevel': fetchUserLevelStub,
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
    lambdaInvokeStub, redisGetStub, redisMGetStub, redisSetStub, publishEventStub, obtainUserLevelStub, obtainActivitiesStub, fetchUserLevelStub
);

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
        
        // todo also test level extraction etc, properly
        obtainUserLevelStub.resolves({ 'user1': 'basic-level-id' });

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

        expect(redisMGetStub).to.have.been.calledOnceWithExactly(['USER_PROFILE::user1']);

        expect(sumPointsStub).to.have.been.calledTwice;
        expect(sumPointsStub).to.have.been.calledWithExactly(['user1'], sinon.match.any, sinon.match.any);
        expect(sumPointsStub).to.have.been.calledWithExactly(['user1'], sinon.match.any);

        expect(obtainUserLevelStub).to.have.been.calledOnceWithExactly(['user1']);
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

        // todo also test level extraction etc, properly
        obtainUserLevelStub.resolves({ 'userY': 'basic-level-id', 'user3': 'higher-level-id' });

        const resultOfHandle = await handler.handleSqsBatch(mockEvent);
        expect(resultOfHandle).to.deep.equal({ statusCode: 200, pointEventsTrigged: 2 });

        expect(redisGetStub).to.have.callCount(6); // during caching, then execution
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(obtainPointsStub).to.have.been.calledThrice;
        
        const expectedFirstInsertion = { eventPointMatchId: 'first', userId: 'user3', numberPoints: 10, eventType: 'SAVING_PAYMENT_SUCCESSFUL', referenceTime: mockRefTime1.format() };
        const expectedSecondInsertion = { eventPointMatchId: 'second', userId: 'userY', numberPoints: 5, eventType: 'BOOST_REDEEMED', referenceTime: mockRefTime2.format() };
        expect(insertPointLogStub).to.have.been.calledOnceWithExactly([expectedFirstInsertion, expectedSecondInsertion]);

        const expectedFirstContext = { context: { awardedForEvent: 'SAVING_PAYMENT_SUCCESSFUL', numberPoints: 10 }};
        const expectedSecondContext = { context: { awardedForEvent: 'BOOST_REDEEMED', numberPoints: 5 }};

        expect(publishEventStub).to.have.been.calledTwice;
        expect(publishEventStub).to.have.been.calledWithExactly('user3', 'HEAT_POINTS_AWARDED', expectedFirstContext);
        expect(publishEventStub).to.have.been.calledWithExactly('userY', 'HEAT_POINTS_AWARDED', expectedSecondContext);

        expect(redisMGetStub).to.have.been.calledOnceWithExactly(['USER_PROFILE::user3', 'USER_PROFILE::userY']);

        expect(sumPointsStub).to.have.been.calledTwice;
        expect(sumPointsStub).to.have.been.calledWithExactly(['user3', 'userY'], sinon.match.any, sinon.match.any);
        expect(sumPointsStub).to.have.been.calledWithExactly(['user3', 'userY'], sinon.match.any);

        expect(obtainUserLevelStub).to.have.been.calledOnceWithExactly(['user3', 'userY']);
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
       const mockUserLevel = {
            userPointsPrior: 25,
            userPointsCurrent: 36,
            levelName: 'Cold',
            levelColor: 'Blue',
            levelColorCode: '#0000ff',
            minumumPoints: 50
        };

        fetchUserLevelStub.resolves(mockUserLevel);

        const mockEvent = helper.wrapQueryParamEvent(null, 'user1');

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);

        expect(resultBody).to.deep.equal({ currentLevel: mockUserLevel });
        expect(fetchUserLevelStub).to.have.been.calledOnceWithExactly('user1');
    });

    it('Sums for multiple users', async () => {
        const mockLatestEventTime = moment().format();
        
        const mockUserIds = ['user1', 'user5', 'user10'];
        const mockTxTypesToInclude = ['USER_SAVING_EVENT', 'WITHDRAWAL'];

        const mockEvent = {
            userIds: mockUserIds,
            includeLastActivityOfType: mockTxTypesToInclude
        };

        obtainUserLevelStub.resolves({ 'user1': 'hot-level-id', 'user5': 'blazing-level-id', 'user10': 'cold-level-id' });

        obtainActivitiesStub.resolves({
            user1: { USER_SAVING_EVENT: { creationTime: mockLatestEventTime }},
            user5: { WITHDRAWAL: { creationTime: mockLatestEventTime }},
            user10: { USER_SAVING_EVENT: { creationTime: mockLatestEventTime }}
        });

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        expect(resultOfHandle).to.deep.equal({
            statusCode: 200,
            userHeatMap: {
                user1: { currentLevel: 'hot-level-id', recentActivity: { USER_SAVING_EVENT: { creationTime: mockLatestEventTime }}},
                user5: { currentLevel: 'blazing-level-id', recentActivity: { WITHDRAWAL: { creationTime: mockLatestEventTime }}},
                user10: { currentLevel: 'cold-level-id', recentActivity: { USER_SAVING_EVENT: { creationTime: mockLatestEventTime }}}
            }
        });

        expect(obtainUserLevelStub).to.have.been.calledOnceWithExactly(mockUserIds, true);
        expect(obtainActivitiesStub).to.have.been.calledOnceWithExactly(mockUserIds, mockTxTypesToInclude);
    });

    it('Handles invalid events and thrown errors', async () => {
        // On invalid event
        await expect(handler.fetchUserHeat({ httpMethod: 'GET' })).to.eventually.deep.equal({ statusCode: 403 });

        fetchUserLevelStub.throws(new Error('Error!'));
        const mockEvent = helper.wrapQueryParamEvent(null, 'user1');

        // On thrown error
        await expect(handler.fetchUserHeat(mockEvent)).to.eventually.deep.equal({ statusCode: 500 });
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

describe('*** UNIT TEST HEAT CALCULATION ***', async () => {
    const testSystemId = uuid();
    const testLevelId = uuid();

    const mockClientId = 'client-id';
    const mockFloatId = 'float-id';

    const mockProfileStringified = JSON.stringify({
        systemWideUserId: testSystemId,
        clientId: mockClientId,
        floatId: mockFloatId
    });

    const mockProfileResult = helper.mockLambdaResponse(JSON.stringify({ body: mockProfileStringified }));

    beforeEach(() => helper.resetStubs(obtainStateUsersStub, redisMGetStub, lambdaInvokeStub, pointLevelsStub, sumPointsStub));

    it('Calculates heat score for all users', async () => {
        obtainStateUsersStub.resolves([testSystemId]);

        redisMGetStub.onFirstCall().resolves([]);
        redisMGetStub.onSecondCall().resolves([mockProfileStringified]);

        lambdaInvokeStub.returns({ promise: () => mockProfileResult });
        pointLevelsStub.resolves([{ levelId: testLevelId, clientId: mockClientId, floatId: mockFloatId }]);

        sumPointsStub.onFirstCall().resolves({ [testSystemId]: 55 });
        sumPointsStub.onSecondCall().resolves({ [testSystemId]: 144 });

        obtainUserLevelStub.resolves({ [testSystemId]: 'basic-level-id' });

        pointLevelsStub.resolves([
            { levelId: 'basic-level-id', minimumPoints: 50, name: 'Cold' },
            { levelId: 'higher-level-id', minimumPoints: 100, name: 'Hot' }
        ]);

        const resultOfCalc = await handler.calculateHeatStateForAllUsers({});
        expect(resultOfCalc).to.deep.equal({ statusCode: 200, usersUpdated: 1 });

        expect(obtainStateUsersStub).to.have.been.calledOnceWithExactly();

        expect(redisMGetStub).to.have.been.calledTwice;
        expect(redisMGetStub.getCall(0).args[0]).to.deep.equal([`USER_PROFILE::${testSystemId}`]);
        expect(redisMGetStub.getCall(1).args[0]).to.deep.equal([`USER_PROFILE::${testSystemId}`]);

        const expectedProfileInvocation = helper.wrapLambdaInvoc('profile_fetch', false, { systemWideUserId: testSystemId });
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedProfileInvocation);

        expect(sumPointsStub).to.have.been.calledTwice;
        expect(sumPointsStub).to.have.been.calledWithExactly([testSystemId], sinon.match.any, sinon.match.any);
        expect(sumPointsStub).to.have.been.calledWithExactly([testSystemId], sinon.match.any);

        const expectedPublishContext = {
            context: {
                priorLevel: { levelId: 'basic-level-id', minimumPoints: 50, name: 'Cold' },
                newLevel: { levelId: 'higher-level-id', minimumPoints: 100, name: 'Hot' }
            }
        };

        expect(publishEventStub).to.have.been.calledOnceWithExactly(testSystemId, 'HEAT_LEVEL_UP', expectedPublishContext);
    });

    it('Handles thrown errors and no users with state', async () => {
        obtainStateUsersStub.resolves([]);
        await expect(handler.calculateHeatStateForAllUsers({ })).to.eventually.deep.equal({ statusCode: 200, usersUpdated: 0 });

        obtainStateUsersStub.reset();

        obtainStateUsersStub.throws(new Error('Error!'));
        await expect(handler.calculateHeatStateForAllUsers({ })).to.eventually.deep.equal({ statusCode: 500, error: JSON.stringify('Error!') });
    });

});
