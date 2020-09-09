'use strict';

const moment = require('moment');
const camelCaseKeys = require('camelcase-keys');

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const proxyquire = require('proxyquire');

const queryStub = sinon.stub();
const insertStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
    }
}

const savingHeatRds = proxyquire('../persistence/rds.heat', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => helper.resetStubs(queryStub, insertStub);

describe('*** USER ACTIVITY *** SAVING HEAT POINT INSERTION', async () => {
    
    beforeEach(resetStubs);

    it('Fetch number of points and parameters for an event', async () => {
        const expectedQuery = 'select event_point_match_id, number_points, parameters from transaction_data.event_point_list ' +
            'where client_id = $1 and float_id = $2 and event_type = $3';
        queryStub.resolves([{ 'event_point_match_id': 'somePointJoin', 'number_points': 10, 'parameters': {} }]);
        
        const resultOfQuery = await savingHeatRds.obtainPointsForEvent('client', 'float', 'EVENT_TYPE');
        expect(resultOfQuery).to.deep.equal({ eventPointMatchId: 'somePointJoin', numberPoints: 10, parameters: {} });

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['client', 'float', 'EVENT_TYPE']);
    });

    it('Insert savings heat points for user', async () => {
        // note : could use a select subclause to get the points, but if a user event fires _while_ admin is updating point scores, the _prior_ scores should hold,
        // i.e., avoid race condition here by using previously pulled figure
        const expectedQuery = 'insert into transaction_data.point_log (owner_user_id, event_point_match_id, number_points) values %L';
        const expectColumnTemplate = '${userId}, ${eventPointMatchId}, ${numberPoints}';
        const expectedRow = [{ userId: 'userX', eventPointMatchId: 'somePointJoin', numberPoints: 5 }];

        const resultOfQuery = await savingHeatRds.insertPointLogs([{ userId: 'userX', eventPointMatchId: 'somePointJoin', numberPoints: 5 }]);

        expect(resultOfQuery).to.deep.equal({ result: 'INSERTED' });
        expect(insertStub).to.have.been.calledOnceWithExactly(expectedQuery, expectColumnTemplate, expectedRow);
    });

    it('Returns list of events for which non-zero points are active', async () => {
        const expectedQuery = 'select event_type from transaction_data.event_point_list where ' +
            'number_points > 0 and active = true and event_type in ($1, $2)';
        queryStub.resolves([{ 'event_type': 'SECOND_EVENT_TYPE' }]);

        const resultOfQuery = await savingHeatRds.filterForPointRelevance(['FIRST_EVENT_TYPE', 'SECOND_EVENT_TYPE']);

        expect(resultOfQuery).to.deep.equal(['SECOND_EVENT_TYPE']);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['FIRST_EVENT_TYPE', 'SECOND_EVENT_TYPE']);
    });

});

describe('*** USER ACTIVITY *** SAVING HEAT SUMMATION', async () => {
    beforeEach(resetStubs);

    it('Sum up number of points, all time, single user', async () => {
        const expectedQuery = 'select owner_user_id, sum(number_points) from transaction_data.point_log ' +
            'where owner_user_id in ($1) group by owner_user_id';
        queryStub.resolves([{ 'owner_user_id': 'some-user', 'sum': 1440 }]);

        const resultOfQuery = await savingHeatRds.sumPointsForUsers(['some-user']);

        expect(resultOfQuery).to.deep.equal({ 'some-user': 1440 });
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['some-user']);
    });

    it('Sum up points, large number users, current', async () => {
        const testStart = moment().subtract(30, 'days');
        const testEnd = moment();

        const mockUserRow = (userId, points) => ({ 'owner_user_id': userId, 'sum': points });

        const expectedQuery = 'select owner_user_id, sum(number_points) from transaction_data.point_log ' +
            'where owner_user_id in ($1, $2, $3) and creation_time > $4 and creation_time < $5 group by owner_user_id';
        queryStub.resolves([mockUserRow('user1', 10), mockUserRow('user5', 34), mockUserRow('user8', 20)]);

        const resultOfQuery = await savingHeatRds.sumPointsForUsers(['user1', 'user8', 'user5'], testStart, testEnd);
        expect(resultOfQuery).to.deep.equal({ 'user1': 10, 'user5': 34, 'user8': 20 });

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['user1', 'user8', 'user5', testStart.format(), testEnd.format()]);
    });

    it('Obtain user point history', async () => {
        const mockPointRow = (numberPoints, eventType, daysAgo) => (
            { 'creation_time': moment().subtract(daysAgo, 'days').format(), 'event_type': eventType, 'number_points': numberPoints }
        );

        // point per event can change over time
        const mockHistory = [mockPointRow(10, 'USER_SAVING_EVENT', 60), mockPointRow(10, 'USER_SAVING_EVENT', 40), 
            mockPointRow(25, 'REFERRAL_CODE_USED', 12), mockPointRow(5, 'FRIEND_ACCEPTED', 3), mockPointRow(12, 'USER_SAVING_EVENT', 1)];
        
        const expectedQuery = 'select transaction_data.point_log.*, transaction_data.event_point_list.event_type from ' +
            'transaction_data.point_log inner join transaction_data.event_point_list on ' +
            'transaction_data.point_log.event_point_match_id = transaction_data.event_point_list.event_point_match_id ' +
            'where transaction_data.point_log.owner_user_id = $1 order by creation_time desc';

        queryStub.resolves(mockHistory);

        const resultOfQuery = await savingHeatRds.obtainPointHistory('userX');
        expect(resultOfQuery).to.deep.equal(camelCaseKeys(mockHistory));

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['userX']);
    });

});
