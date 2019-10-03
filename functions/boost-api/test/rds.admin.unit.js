'use strict';

const logger = require('debug')('jupiter:boosts:rds-admin-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire').noCallThru();

const queryStub = sinon.stub();
const updateRecordObjectStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.updateRecordObject = updateRecordObjectStub;
    }
}

const rds = proxyquire('../persistence/rds.admin.boost', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(queryStub, updateRecordObjectStub);
// const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
// const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

const boostMainTable = config.get('tables.boostTable');
const boostAccountTable = config.get('tables.boostAccountJoinTable');

describe('*** UNIT TEST BOOST ADMIN RDS', () => {
    const testAudienceSelection = `whole_universe from #{'{"specific_users": ["${uuid()}","${uuid()}"]}'}`;
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testRedemptionMsgs = [{ accountId: 'ALL', msgInstructionId: uuid() }];
    const testBoostId = uuid();

    const testStartTime = moment();
    const testEndTime = moment().add(1, 'week');
    const testUpdatedTime = moment().format();

    const boostFromPersistence = {
        'boost_id': testBoostId,
        'boost_type': 'SIMPLE::TIME_LIMITED',
        'boost_category': 'USER_CODE_USED',
        'boost_amount': 100000,
        'boost_unit': 'HUNDREDTH_CENT',
        'boost_currency': 'USD',
        'from_bonus_pool_id': 'primary_bonus_pool',
        'from_float_id': 'primary_cash',
        'for_client_id': 'some_client_co',
        'start_time': testStartTime.format(),
        'end_time': testEndTime.format(),
        'status_conditions': testStatusCondition,
        'boost_audience': 'INDIVIDUAL',
        'audience_selection': testAudienceSelection,
        'redemption_messages': { instructions: testRedemptionMsgs },
        'initial_status': 'PENDING',
        'flags': ['REDEEM_ALL_AT_ONCE']
    };

    const boostStatusCount = {
        'boost_id': testBoostId,
        'boost_status': 'CREATED', 
        'count': 10
    };

    const expectedBoostResult = {
        boostId: testBoostId,
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        startTime: testStartTime.format(),
        endTime: testEndTime.format(),
        statusConditions: testStatusCondition,
        boostAudience: 'INDIVIDUAL',
        audienceSelection: testAudienceSelection,
        redemptionMessages: { instructions: testRedemptionMsgs },
        initialStatus: 'PENDING',
        flags: ['REDEEM_ALL_AT_ONCE'],
        count: { CREATED: 10, OFFERED: 0, PENDING: 0, REDEEMED: 0, REVOKED: 0, EXPIRED: 0 }
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Retrieves boosts (with status counts)', async () => {
        const firstQueryArgs = [
            `select * from ${boostMainTable} where active = true and end_time > current_timestamp order by creation_time desc`,
            []
        ];
        const secondQueryArgs = [
            `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`,
            []
        ];
        queryStub.withArgs(...firstQueryArgs).resolves([boostFromPersistence, boostFromPersistence]);
        queryStub.withArgs(...secondQueryArgs).resolves([boostStatusCount, boostStatusCount]);
        const excludedTypeCategories = [];

        const resultOfListing = await rds.listBoosts(excludedTypeCategories, true);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedBoostResult, expectedBoostResult]);
        expect(queryStub).to.have.been.calledWith(...firstQueryArgs);
        expect(queryStub).to.have.been.calledWith(...secondQueryArgs);
    });

    it('Handles excluded type categories', async () => {
        const firstQueryArgs = [
            `select * from ${boostMainTable} where active = true and end_time > current_timestamp and (boost_type || '::' || boost_category) not in ($1) order by creation_time desc`,
            ['REFERRAL::USER_CODE_USED']
        ];
        const secondQueryArgs = [
            `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`,
            []
        ];
        queryStub.withArgs(...firstQueryArgs).resolves([boostFromPersistence, boostFromPersistence]);
        queryStub.withArgs(...secondQueryArgs).resolves([boostStatusCount, boostStatusCount]);
        const excludedTypeCategories = ['REFERRAL::USER_CODE_USED'];

        const resultOfListing = await rds.listBoosts(excludedTypeCategories, true);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedBoostResult, expectedBoostResult]);
        expect(queryStub).to.have.been.calledWith(...firstQueryArgs);
        expect(queryStub).to.have.been.calledWith(...secondQueryArgs);
    });

    it('Includes inactive boosts', async () => {
        const firstQueryArgs = [
            `select * from ${boostMainTable} where (boost_type || '::' || boost_category) not in ($1) order by creation_time desc`,
            ['REFERRAL::USER_CODE_USED']
        ];
        const secondQueryArgs = [
            `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`,
            []
        ];
        queryStub.withArgs(...firstQueryArgs).resolves([boostFromPersistence, boostFromPersistence]);
        queryStub.withArgs(...secondQueryArgs).resolves([boostStatusCount, boostStatusCount]);
        const excludedTypeCategories = ['REFERRAL::USER_CODE_USED'];

        const resultOfListing = await rds.listBoosts(excludedTypeCategories, true, true);
        logger('select args:', queryStub.getCall(0).args);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedBoostResult, expectedBoostResult]);
        expect(queryStub).to.have.been.calledWith(...firstQueryArgs);
        expect(queryStub).to.have.been.calledWith(...secondQueryArgs);
    });

    it('Updates boost', async () => {
        const testUpdateArgs = {
            table: config.get('tables.boostTable'),
            key: { boostId: testBoostId },
            value: { boostStatus: 'OFFERED' },
            returnClause: 'updated_time'
        };
        updateRecordObjectStub.withArgs(testUpdateArgs).resolves([{ 'updated_time': testUpdatedTime }]);

        const updateParams = { boostId: testBoostId, boostStatus: 'OFFERED' };

        const resultOfUpdate = await rds.updateBoost(updateParams);
        logger('Result of update:', resultOfUpdate);
        logger('udpdate args:', updateRecordObjectStub.getCall(0).args);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([{ updatedTime: testUpdatedTime }]);
        expect(updateRecordObjectStub).to.have.been.calledOnceWithExactly(testUpdateArgs);
    });

});
