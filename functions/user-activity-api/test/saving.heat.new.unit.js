'use strict';

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const proxyquire = require('proxyquire');
const moment = require('moment');

const filterEventStub = sinon.stub();
const obtainPointsStub = sinon.stub();
const insertPointLogStub = sinon.stub();

const sumPointsStub = sinon.stub();
const pointHistoryStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const redisGetStub = sinon.stub();
const redisSetStub = sinon.stub();

const publishEventStub = sinon.stub();

const handler = proxyquire('../heat-handler', {
    './persistence/rds.heat': {
        'filterForPointRelevance': filterEventStub,
        'obtainPointsForEvent': obtainPointsStub,
        'insertPointLog': insertPointLogStub,
        'sumPointsForUsers': sumPointsStub,
        'obtainPointHistory': pointHistoryStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': class {
            constructor () { this.invoke = lambdaInvokeStub(); }
        },
        '@noCallThru': true
    },
    'ioredis': class {
        constructor() {
            this.get = redisGetStub;
            this.set = redisSetStub;
        }
    },
    'publish-common': {
        'publishUserEvent': publishEventStub
    }
});

const resetStubs = () => helper.resetStubs(obtainPointsStub, insertPointLogStub, sumPointsStub, pointHistoryStub);

describe('*** USER ACTIVITY *** INSERT POINT RECORD', () => {

    const mockClientId = 'client-id';
    const mockFloatId = 'float-id';

    const wrapAsSqsBatch = events => ({
        Records: events.map((event) => ({ body: JSON.stringify({ Message: JSON.stringify(event) }) }))
    });

    const expectedProfileCall = (systemWideUserId) => helper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId });
    const mockProfileResult = helper.mockLambdaResponse({ body: JSON.stringify({ clientId: mockClientId, floatId: mockFloatId } ) });
    
    const mockPair = (userId, eventType) => ({ userId, eventType });

    beforeEach(resetStubs);

    it('Handles single event, found, and insert points, no user cached', async () => {
        filterEventStub.resolves(['SAVING_PAYMENT_SUCCESSFUL']);
        redisGetStub.resolves(null);
        lambdaInvokeStub.resolves(mockProfileResult);
        obtainPointsStub.resolves({ eventPointMatchId: 'pointJoinId', numberPoints: 7, parameters: {} });
        insertPointLogStub.resolves({ result: 'INSERTED' });

        const mockEvent = wrapAsSqsBatch([mockPair('user1', 'SAVING_PAYMENT_SUCCESSFUL')]);
        const resultOfHandle = await handler.handleSqsBatch(mockEvent);

        expect(resultOfHandle).to.deep.equal({ statusCode: 200, pointEventsTrigged: 1 });

        expect(filterEventStub).to.have.been.calledOnceWithExactly(['SAVING_PAYMENT_SUCCESSFUL']);

        expect(redisGetStub).to.have.been.calledOnceWithExactly('USER_PROFILE::user1');
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(expectedProfileCall('user1'));
        const expectedToCache = JSON.stringify({ clientId: mockClientId, floatId: mockFloatId }); // actually will have more but these relevant
        expect(redisSetStub).to.have.been.calledOnceWithExactly('USER_PROFILE::user1', expectedToCache, 'EX', 25200);

        expect(obtainPointsStub).to.have.been.calledOnceWithExactly(mockClientId, mockFloatId, 'SAVING_PAYMENT_SUCCESSFUL');
        
        const expectedInsertion = { eventPointMatchId: 'pointJoinId', userId: 'user1', numberPoints: 7 };
        expect(insertPointLogStub).to.have.been.calledOnceWithExactly([expectedInsertion]);

        const expectedContext = { numberPoints: 7, awardedForEvent: 'SAVING_PAYMENT_SUCCESSFUL' }; // for the moment ; also, nb : filter out HEAT_POINTS_AWARDED on SQS sub
        expect(publishEventStub).to.have.been.calledOnceWithExactly('user1', 'HEAT_POINTS_AWARDED', { context: expectedContext });
    });

    it('Handles single event, found, insert points, user cached', async () => {
        const mockEventType = 'USER_GAME_RESPONSE';
        
        filterEventStub.resolves([mockEventType]);
        redisGetStub.resolves(JSON.stringify({ clientId: mockClientId, floatId: mockFloatId }));
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
        const mockEvent = wrapAsSqsBatch([
            mockPair('user3', 'SAVING_PAYMENT_SUCCESSFUL'),
            mockPair('userN', 'MESSAGE_SENT'),
            mockPair('userY', 'BOOST_REDEEMED'),
            mockPair('userF', 'USER_GAME_RESPONSE')
        ]);

        filterEventStub.resolves(['SAVING_PAYMENT_SUCCESSFUL', 'BOOST_REDEEMED', 'USER_GAME_RESPONSE']);
        redisGetStub.withArgs('USER_PROFILE::user3').resolves(JSON.stringify({ clientId: mockClientId, floatId: mockFloatId }));
        lambdaInvokeStub.resolves(mockProfileResult);
        
        obtainPointsStub.withArgs(mockClientId, mockFloatId, 'SAVING_PAYMENT_SUCCESSFUL').resolves({ numberPoints: 10, eventPointMatchId: 'first' });
        obtainPointsStub.withArgs(mockClientId, mockFloatId, 'BOOST_REDEEMED').resolves({ numberPoints: 5, eventPointMatchId: 'second' });
        // filter is generous in that it allows to pass events that other clients may give points for (otherwise have to fetch all client-float pairs upfront)
        // so make sure handle this case
        obtainPointsStub.withArgs(mockClientId, mockFloatId, 'USER_GAME_RESPONSE').resolves(null);
        insertPointLogStub.resolves({ result: 'INSERTED' });

        const resultOfHandle = await handler.handleSqsBatch(mockEvent);
        expect(resultOfHandle).to.deep.equal({ statusCode: 200, pointEventsTrigged: 2 });

        expect(redisGetStub).to.have.been.calledThrice;
        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(obtainPointsStub).to.have.been.calledThrice;
        
        const expectedFirstInsertion = { eventPointMatchId: 'first', userId: 'user3', numberPoints: 10 };
        const expectedSecondInsertion = { eventPointMatchId: 'second', userId: 'userY', numberPoints: 5 };
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
        sumPointsStub.resolves({ 'user1': 105 });
        // we are going to need to fetch the heat "levels" too

        const mockEvent = helper.wrapQueryParamEvent(null, 'user1');

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);
        expect(resultBody).to.deep.equal({ currentPoints: 105 });

        expect(sumPointsStub).to.have.been.calledOnceWithExactly(['user1']); // also will need a time filter
    });

    it('Sums for multiple users, specified dates', async () => {
        const mockStart = moment().subtract(30, 'days');
        const mockEnd = moment();

        const mockEvent = {
            userIds: ['user1', 'user5', 'user10'],
            startDateMillis: mockStart.valueOf(),
            endDateMillis: mockEnd.valueOf()
        };

        const pointSums = { 'user1': 105, 'user5': 200, 'user10': 3 }; 
        sumPointsStub.resolves(pointSums);

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);
        
        expect(resultBody).to.deep.equal(pointSums);
    });

    it('Obtains a user point history', async () => {
        const mockMoments = [moment().subtract(20, 'days'), moment().subtract(5, 'days'), moment().subtract(1, 'days')];
        const mockPointHistory = [
            { creationTime: mockMoments[0], eventType: 'SAVING_PAYMENT_SUCCESSFUL', numberPoints: 10 },
            { creationTime: mockMoments[1], eventType: 'BOOST_REDEEMED', numberPoints: 5 },
            { creationTime: mockMoments[2], eventType: 'USER_GAME_RESPONSE', numberPoints: 7 },
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
