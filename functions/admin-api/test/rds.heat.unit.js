'use strict';

// const logger = require('debug')('jupiter:admin:heat:unit')
const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./test.helper');

const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const uuidStub = sinon.stub();

const queryStub = sinon.stub();
const insertRecordsStub = sinon.stub();
const multiUpdateInsertStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertRecordsStub;
        this.multiTableUpdateAndInsert = multiUpdateInsertStub;
    }
}

const rds = proxyquire('../persistence/rds.heat.admin', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub
});

describe('*** UNIT TEST ADMIN HEAT RDS ***', () => {
    const testAdminId = uuid();
    const testLevelId = uuid();
    const testEventMatchId = uuid();

    const testCreationTime = moment();
    const testUpdatedTime = moment();

    const testClientId = 'a_client_id';
    const testFloatId = 'primary_cash';

    const levelThresholdFromRds = {
        'level_id': testLevelId,
        'client_id': testClientId,
        'float_id': testFloatId,
        'level_name': 'Easy',
        'level_color': 'Green',
        'level_color_code': '#008000',
        'minimum_points': 5
    };

    const eventPointItemFromRds = {
        'event_point_match_id': testEventMatchId,
        'client_id': testClientId,
        'float_id': testFloatId,
        'event_type': 'SAVING_PAYMENT_SUCCESSFUL',
        'creating_user_id': testAdminId,
        'active': true,
        'number_points': 20,
        'parameters': {}
    };

    beforeEach(() => helper.resetStubs(queryStub, insertRecordsStub, multiUpdateInsertStub, uuidStub));

    it('Upserts event-point items', async () => {
        const testEventPointItems = [
            { eventPointMatchId: testEventMatchId, userId: 'user1', numberPoints: 7 },
            { userId: 'user2', numberPoints: 10 }
        ];

        multiUpdateInsertStub.resolves([
            [{ 'creation_time': testCreationTime.format() }],
            [{ 'updated_time': testUpdatedTime.format() }]
        ]);

        uuidStub.returns(testEventMatchId);

        const resultOfUpsert = await rds.upsertEventPointItems(testEventPointItems, testAdminId);
        expect(resultOfUpsert).to.deep.equal({ result: 'SUCCESS', updated: 1, inserted: 1 });

        const expectedInsertQuery = 'insert into transaction_data.event_point_list (event_point_match_id, creating_user_id, user_id, ' +
            'number_points) values %L returning creation_time';

        const expectedInsertDef = {
            query: expectedInsertQuery,
            columnTemplate: '${eventPointMatchId}, ${creatingUserId}, ${userId}, ${numberPoints}',
            rows: [{
                eventPointMatchId: testEventMatchId,
                creatingUserId: testAdminId,
                userId: 'user2',
                numberPoints: 10
            }]
        };

        const expectedUpdateDef = {
            table: 'transaction_data.event_point_list',
            key: { 'eventPointMatchId': testEventMatchId },
            value: { numberPoints: 7 },
            returnClause: 'updated_time' 
        };

        expect(multiUpdateInsertStub).to.have.been.calledOnceWithExactly([expectedUpdateDef], [expectedInsertDef]);
    });

    it('Upserts heat-point thresholds', async () => {
        const testLevelConfigs = [
            { levelId: testLevelId, minimumPoints: 5, levelName: 'Easy', levelColor: 'Green', levelColorCode: '#008000' },
            { minimumPoints: 20, levelName: 'Hard', levelColor: 'Blue', levelColorCode: '#0000ff' }
        ];

        multiUpdateInsertStub.resolves([
            [{ 'creation_time': testCreationTime.format() }],
            [{ 'updated_time': testUpdatedTime.format() }]
        ]);

        uuidStub.returns(testLevelId);

        const resultOfUpsert = await rds.upsertHeatPointThresholds(testLevelConfigs, testAdminId);
        expect(resultOfUpsert).to.deep.equal({ result: 'SUCCESS', updated: 1, inserted: 1 });

        const expectedInsertQuery = 'insert into transaction_data.point_heat_level (level_id, creating_user_id, minimum_points, ' +
            'level_name, level_color, level_color_code) values %L returning creation_time';

        const expectedInsertDef = {
            query: expectedInsertQuery,
            columnTemplate: '${levelId}, ${creatingUserId}, ${minimumPoints}, ${levelName}, ${levelColor}, ${levelColorCode}',
            rows: [{
                levelId: testLevelId,
                creatingUserId: testAdminId,
                minimumPoints: 20,
                levelName: 'Hard',
                levelColor: 'Blue',
                levelColorCode: '#0000ff'
            }]
        };

        const expectedUpdateDef = {
            table: 'transaction_data.point_heat_level',
            key: { 'levelId': testLevelId },
            value: { minimumPoints: 5, levelName: 'Easy', levelColor: 'Green', levelColorCode: '#008000' },
            returnClause: 'updated_time'
        };

        expect(multiUpdateInsertStub).to.have.been.calledOnceWithExactly([expectedUpdateDef], [expectedInsertDef]);
    });

    it('Inserts heat-point thresholds where no update definitions found', async () => {
        const testLevelConfigs = [
            { minimumPoints: 50, levelName: 'Unfair', levelColor: 'Red', levelColorCode: '#ff0000' }
        ];

        insertRecordsStub.resolves({ 'creation_time': testCreationTime });
        uuidStub.returns(testLevelId);

        const resultOfUpsert = await rds.upsertHeatPointThresholds(testLevelConfigs, testAdminId);
        expect(resultOfUpsert).to.deep.equal({ result: 'SUCCESS', updated: 0, inserted: 1 });

        const expectedQuery = 'insert into transaction_data.point_heat_level (level_id, creating_user_id, minimum_points, ' +
            'level_name, level_color, level_color_code) values %L returning creation_time';

        const expectedColumnTemplate = '${levelId}, ${creatingUserId}, ${minimumPoints}, ${levelName}, ${levelColor}, ${levelColorCode}';

        const expectedRows = [{
            levelId: testLevelId,
            creatingUserId: testAdminId,
            minimumPoints: 50,
            levelName: 'Unfair',
            levelColor: 'Red',
            levelColorCode: '#ff0000'
        }];

        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedColumnTemplate, expectedRows);
    });

    it('Fetches heat level thresholds', async () => {
        queryStub.resolves([levelThresholdFromRds]);

        const resultOfFetch = await rds.fetchHeatLevelThresholds(testClientId, testFloatId);

        const expectedResult = {
            levelId: testLevelId,
            clientId: testClientId,
            floatId: testFloatId,
            levelName: 'Easy',
            levelColor: 'Green',
            levelColorCode: '#008000',
            minimumPoints: 5
        };
        expect(resultOfFetch).to.deep.equal([expectedResult]);
    });

    it('Fetches event-point items', async () => {
        queryStub.resolves([eventPointItemFromRds]);

        const resultOfFetch = await rds.fetchEventPointItems(testClientId, testFloatId);

        const expectedResult = {
            eventPointMatchId: testEventMatchId,
            clientId: testClientId,
            floatId: testFloatId,
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            creatingUserId: testAdminId,
            active: true,
            numberPoints: 20,
            parameters: {}
        };
        expect(resultOfFetch).to.deep.equal([expectedResult]);
    });

});
