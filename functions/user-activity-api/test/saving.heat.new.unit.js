'use strict';

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const proxyquire = require('proxyquire');
const moment = require('moment');

const obtainPointsStub = sinon.stub();
const insertPointLogStub = sinon.stub();

const sumPointsStub = sinon.stub();
const pointHistoryStub = sinon.stub();

const handler = proxyquire('../heat-handler', {
    './persistence/rds.heat': {
        'obtainPointsForEvent': obtainPointsStub,
        'insertPointLog': insertPointLogStub,
        'sumPointsForUsers': sumPointsStub,
        'obtainPointHistory': pointHistoryStub,
        '@noCallThru': true
    }
});

const resetStubs = () => helper.resetStubs(obtainPointsStub, insertPointLogStub, sumPointsStub, pointHistoryStub);

describe('*** USER ACTIVITY *** INSERT POINT RECORD', () => {

    const wrapAsSqsBatch = events => ({
        Records: events.map((event) => ({ body: JSON.stringify({ Message: JSON.stringify(event) }) }))
    });
    
    const mockPair = (userId, eventType) => ({ userId, eventType });    

    beforeEach(resetStubs);

    it('Handles single event, found, and insert points', async () => {
        
        const mockEvent = wrapAsSqsBatch([mockPair('user1', 'SAVING_PAYMENT_SUCCESSFUL')]);
        const resultOfHandle = await handler.handleSqsBatch(mockEvent);

        expect(resultOfHandle).to.deep.equal({ statusCode: 200 });
    });

    it('Handles batch events, some found, others not', async () => {

        const mockEvent = wrapAsSqsBatch([
            mockPair('user3', 'SAVING_PAYMENT_SUCCESSFUL'),
            mockPair('userN', 'MESSAGE_SENT'),
            mockPair('userY', 'BOOST_REDEEMED')
        ]);

        const resultOfHandle = await handler.handleSqsBatch(mockEvent);

    });

    it('Does nothing when none found', async () => {

        const mockEvent = wrapAsSqsBatch(['user1', 'user2', 'user3', 'user4'].map((userId) => mockPair(userId, 'MESSAGE_SENT')));
        const resultOfHandle = await handler.handleSqsBatch(mockEvent);

    });

});

describe('*** USER ACTIVITY *** FETCH POINTS', () => {

    beforeEach(resetStubs);

    it('Sums for single user, simple, with default dates, via API call', async () => {

        const mockEvent = helper.wrapQueryParamEvent(null, 'user1');
        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);


    });

    it('Sums for multiple users, specified dates', async () => {
        const mockStart = moment().subtract(30, 'days');
        const mockEnd = moment();

        const mockEvent = {
            userIds: ['user1', 'user5', 'user10'],
            startDateMillis: mockStart.valueOf(),
            endDateMillis: mockEnd.valueOf()
        };

        const resultOfHandle = await handler.fetchUserHeat(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);

    });

    it('Obtains a user point history', async () => {
        const mockEvent = helper.wrapQueryParamEvent(null, 'userX');
        const resultOfHandle = await handler.fetchHeatPointRecord(mockEvent);
        const resultBody = helper.standardOkayChecks(resultOfHandle);
    });

});
