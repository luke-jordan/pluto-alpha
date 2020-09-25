'use strict';

// const logger = require('debug')('jupiter:admin:unit');
const uuid = require('uuid/v4');

const helper = require('./test.helper');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const upsertPointItemsStub = sinon.stub();
const upsertHeatThresholdStub = sinon.stub();
const fetchHeatThresholdStub = sinon.stub();
const fetchPointItemsStub = sinon.stub();

const handler = proxyquire('../admin-heat-handler.js', {
    './persistence/rds.heat.admin': {
        'upsertEventPointItems': upsertPointItemsStub,
        'upsertHeatPointThresholds': upsertHeatThresholdStub,
        'fetchHeatLevelThresholds': fetchHeatThresholdStub,
        'fetchEventPointItems': fetchPointItemsStub
    }
});

describe('*** UNIT TEST WRITE HEAT CONFIG ***', () => {
    const testAdminId = uuid();
    const testLevelId = uuid();

    beforeEach(() => helper.resetStubs(upsertHeatThresholdStub, upsertPointItemsStub));

    it('Writes heat configuration: Event-point pairs', async () => {
        upsertPointItemsStub.resolves({ result: 'SUCCESS', updated: 3, inserted: 2 });

        const testEventBody = {
            eventPointItems: [
                { eventPointMatchId: 'event_point_id_1', userId: 'user1', numberPoints: 13 },
                { eventPointMatchId: 'event_point_id_2', userId: 'user2', numberPoints: 7 },
                { eventPointMatchId: 'event_point_id_3', userId: 'user3', numberPoints: 11 },
                { userId: 'user4', numberPoints: 5 },
                { userId: 'user5', numberPoints: 17 }
            ]
        };

        const testEvent = helper.wrapHttpPathEvent(testEventBody, 'event', testAdminId);

        const resultOfWrite = await handler.writeHeatConfig(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfWrite, true);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updated: 3, inserted: 2 });
        expect(upsertPointItemsStub).to.have.been.calledOnceWithExactly(testEventBody.eventPointItems, testAdminId);
    });

    it('Writes heat configuration: Level thresholds', async () => {    
        upsertHeatThresholdStub.resolves({ result: 'SUCCESS', updated: 1, inserted: 1 });

        const testEventBody = {
            levelConfigurations: [
                { levelId: testLevelId, minimumPoints: 5, levelName: 'Easy', levelColor: 'Green', levelColorCode: '#008000' },
                { minimumPoints: 20, levelName: 'Hard', levelColor: 'Blue', levelColorCode: '#0000ff' }
            ]
        };

        const testEvent = helper.wrapHttpPathEvent(testEventBody, 'level', testAdminId);

        const resultOfWrite = await handler.writeHeatConfig(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfWrite, true);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updated: 1, inserted: 1 });
        expect(upsertHeatThresholdStub).to.have.been.calledOnceWithExactly(testEventBody.levelConfigurations, testAdminId);
    });

    it('Handles invalid events and thrown errors', async () => {
        // On unauthorized event
        await expect(handler.writeHeatConfig({})).to.eventually.deep.equal({ statusCode: 403, headers: helper.expectedHeaders });

        const testEvent = helper.wrapHttpPathEvent({ }, 'level', testAdminId);
        const expectedResult = { statusCode: 500, headers: helper.expectedHeaders, body: JSON.stringify('Unknown operation') };

        // On unknown op and thrown error
        await expect(handler.writeHeatConfig(testEvent)).to.eventually.deep.equal(expectedResult);
    });

});

describe('*** UNIT TEST FETCH HEAT CONFIG ***', () => {
    const testAdminId = uuid();
    const testLevelId = uuid();

    const testEventMatchId = uuid();

    const testClientId = 'a_client_id';
    const testFloatId = 'primary_cash';

    const testEventPointItem = {
        eventPointMatchId: testEventMatchId,
        clientId: testClientId,
        floatId: testFloatId,
        eventType: 'SAVING_PAYMENT_SUCCESSFUL',
        creatingUserId: testAdminId,
        active: true,
        numberPoints: 50,
        parameters: {}
    };

    const testHeatThreshold = {
        levelId: testLevelId,
        clientId: testClientId,
        floatId: testFloatId,
        levelName: 'Easy',
        levelColor: 'Green',
        levelColorCode: '#008000',
        minimumPoints: 15
    };

    beforeEach(() => helper.resetStubs(fetchHeatThresholdStub, fetchPointItemsStub));

    it('Fetches heat configuration: heat level thresholds and event point items', async () => {
        fetchHeatThresholdStub.resolves([testHeatThreshold]);
        fetchPointItemsStub.resolves([testEventPointItem]);

        const testEventBody = { clientId: testClientId, floatId: testFloatId };
        const testEvent = helper.wrapQueryParamEvent(testEventBody, testAdminId, 'SYSTEM_ADMIN', 'GET');

        const resultOfFetch = await handler.fetchHeatConfiguration(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfFetch, true);

        const expectedResult = { levelThresholds: [testHeatThreshold], eventPointItems: [testEventPointItem] };
        expect(resultBody).to.deep.equal(expectedResult);

        expect(fetchHeatThresholdStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(fetchPointItemsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);

    });

    it('Handles invalid events and thrown errors', async () => {
        // On unauthorized event
        await expect(handler.fetchHeatConfiguration({})).to.eventually.deep.equal({ statusCode: 403, headers: helper.expectedHeaders });

        fetchHeatThresholdStub.throws(new Error('Error!'));

        const testEvent = helper.wrapQueryParamEvent({ }, testAdminId, 'SYSTEM_ADMIN', 'GET');
        const expectedResult = { statusCode: 500, headers: helper.expectedHeaders, body: JSON.stringify('Error!') };

        // On thrown error
        await expect(handler.fetchHeatConfiguration(testEvent)).to.eventually.deep.equal(expectedResult);
    });
});
