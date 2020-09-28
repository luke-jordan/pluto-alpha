'use strict';

// const logger = require('debug')('jupiter:heat:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const camelCaseKeys = require('camelcase-keys');

const helper = require('./test.helper');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const { expect } = chai;

const proxyquire = require('proxyquire');

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const updateRecordStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.updateRecordObject = updateRecordStub;
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
        const mockRefTime = moment();

        const expectedQuery = 'insert into transaction_data.point_log (owner_user_id, event_point_match_id, number_points, reference_time) values %L';
        const expectColumnTemplate = '${userId}, ${pointMatchId}, ${numberPoints}, ${referenceTime}';
        const expectedRow = [{ userId: 'userX', pointMatchId: 'somePointJoin', numberPoints: 5, referenceTime: mockRefTime.format() }];

        const resultOfQuery = await savingHeatRds.insertPointLogs([{ userId: 'userX', eventPointMatchId: 'somePointJoin', numberPoints: 5, referenceTime: mockRefTime.format() }]);

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
            'where owner_user_id in ($1, $2, $3) and reference_time > $4 and reference_time < $5 group by owner_user_id';
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

describe('*** UNIT TEST RDS HEAT FUNCTIONS ***', async () => {
    const testLevelId = uuid();
    const testUserId = uuid();

    const testClientId = 'client_id';
    const testFloatId = 'float_id';

    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockLevelThreshold = {
        'level_id': testLevelId,
        'client_id': testClientId,
        'float_id': testFloatId,
        'level_name': 'Hard',
        'level_color': 'Blue',
        'level_color_code': '#ff0000',
        'minimum_points': 50
    };

    beforeEach(() => helper.resetStubs(queryStub, insertStub));

    it('Obtains point levels', async () => {
        queryStub.resolves([mockLevelThreshold]);
        const resultOfFetch = await savingHeatRds.obtainPointLevels(testClientId, testFloatId);

        const expectedResult = {
            levelId: testLevelId,
            clientId: testClientId,
            floatId: testFloatId,
            levelName: 'Hard',
            levelColor: 'Blue',
            levelColorCode: '#ff0000',
            minimumPoints: 50
        };

        expect(resultOfFetch).to.deep.equal([expectedResult]);

        const expectedQuery = 'select * from transaction_data.point_heat_level where client_id = $1 and float_id = $2 order by minimum_points desc';
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, [testClientId, testFloatId]);
    });
    
    it('Establishes user state', async () => {
        queryStub.resolves([]);
        insertStub.resolves({ rows: [{ 'creation_time': testCreationTime }]});
        const resultOfInsert = await savingHeatRds.establishUserState(testUserId);
        expect(resultOfInsert).to.deep.equal({ rows: [{ 'creation_time': testCreationTime }]});
        
        const expectedSelectQuery = 'select current_period_points from transaction_data.user_heat_state where system_wide_user_id = $1';
        const expectedInsertQuery = 'insert into transaction_data.user_heat_state (system_wide_user_id) values %L returning creation_time';

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedSelectQuery, [testUserId]);
        expect(insertStub).to.have.been.calledOnceWithExactly(expectedInsertQuery, '${systemWideUserId}', [{ systemWideUserId: testUserId }]);
        queryStub.reset();

        queryStub.resolves([{ 'current_period_points': 17 }]);

        // Does not create new state where state already exists
        await expect(savingHeatRds.establishUserState(testUserId)).to.eventually.deep.equal('USER_EXISTS');
    });

    it('Updates user state', async () => {
        updateRecordStub.resolves([{ 'updated_time': testUpdatedTime }]);

        const updateParams = {
            systemWideUserId: testUserId,
            currentPeriodPoints: 11,
            priorPeriodPoints: 7,
            currentLevelId: testLevelId
        };

        const resultOfUpdate = await savingHeatRds.updateUserState(updateParams);
        expect(resultOfUpdate).to.deep.equal({ result: 'UPDATED' });

        const expectedUpdateDef = {
            table: config.get('tables.heatStateLedger'),
            key: { systemWideUserId: testUserId },
            value: { currentPeriodPoints: 11, priorPeriodPoints: 7, currentLevelId: testLevelId },
            returnClause: 'updated_time'
        };

        expect(updateRecordStub).to.have.been.calledOnceWithExactly(expectedUpdateDef);
    });

    it('Obtains all users with state', async () => {
        queryStub.resolves([{ 'system_wide_user_id': testUserId }]);
        const resultOfFetch = await savingHeatRds.obtainAllUsersWithState();
        expect(resultOfFetch).to.deep.equal([testUserId]);
        expect(queryStub).to.have.been.calledOnceWithExactly('select system_wide_user_id from transaction_data.user_heat_state', []);
    });

    it('Obtains user levels', async () => {
        queryStub.resolves([{ 'system_wide_user_id': testUserId, 'current_level_id': testLevelId }]);
        const resultOfFetch = await savingHeatRds.obtainUserLevels([testUserId]);
        expect(resultOfFetch).to.deep.equal({ [testUserId]: testLevelId });

        const expectedQuery = 'select system_wide_user_id, current_level_id from transaction_data.user_heat_state where system_wide_user_id in ($1)';
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, [testUserId]);
    });

});
