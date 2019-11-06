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
        'boost_type': 'SIMPLE',
        'boost_category': 'TIME_LIMITED',
        'boost_amount': 100000,
        'boost_unit': 'HUNDREDTH_CENT',
        'boost_currency': 'USD',
        'boost_budget': 10000000,
        'boost_redeemed': 600000,
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
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        boostRedeemed: 600000,
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

describe('*** UNIT TEST BOOST LIST RDS FUNCTIONS ***', () => {
    const testUserId = uuid();
    const testAccountId = uuid();
    const testBoostId = uuid();

    const testStartTime = moment();
    const testEndTime = moment();
    
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };

    const boostFromPersistence = {
        'creating_user_id': testUserId,
        'boost_id': testBoostId,
        'boost_type': 'SIMPLE',
        'label': 'SDFSDF',
        'boost_category': 'TIME_LIMITED',
        'boost_amount': 100000,
        'boost_unit': 'HUNDREDTH_CENT',
        'active': true,
        'boost_currency': 'USD',
        'from_float_id': 'primary_cash',
        'for_client_id': 'some_client_co',
        'start_time': testStartTime.format(),
        'end_time': testEndTime.format(),
        'status_conditions': testStatusCondition,
        'initial_status': 'PENDING',
    };

    beforeEach(() => {
        testHelper.resetStubs(queryStub);
    });

    // add expectations, with args
    it('Fetches user boosts', async () => {
        queryStub.resolves([boostFromPersistence, boostFromPersistence]);

        const result = await rds.fetchUserBoosts(testAccountId);
        logger('Result of user boost extraction:', result);
    });

    it('Finds user accounts', async () => {
        queryStub.resolves([{ 'account_id': uuid() }, { 'account_id': uuid() }]);

        const result = await rds.findAccountsForUser(testUserId);
        logger('Got user accounts:', result);
    });
});
