'use strict';

const logger = require('debug')('jupiter:boosts:rds-admin-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const testHelper = require('./boost.test.helper');
const camelizeKeys = require('camelize-keys');

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
        'label': 'Win a boost!',
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
        'boost_audience_type': 'INDIVIDUAL',
        'audience_selection': testAudienceSelection,
        'redemption_messages': { instructions: testRedemptionMsgs },
        'initial_status': 'PENDING',
        'game_params': { gameType: 'CHASE_THE_ARROW' },
        'flags': ['REDEEM_ALL_AT_ONCE']
    };

    const boostStatusCount = {
        'boost_id': testBoostId,
        'boost_status': 'CREATED', 
        'count': 10
    };

    const expectedBoostResult = {
        boostId: testBoostId,
        label: 'Win a boost!',
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
        boostAudienceType: 'INDIVIDUAL',
        gameParams: { gameType: 'CHASE_THE_ARROW' },
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
        const firstQueryArgs = [`select * from ${boostMainTable}  order by creation_time desc`, []];
        const secondQueryArgs = [
            `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`,
            []
        ];
        queryStub.onFirstCall().resolves([boostFromPersistence, boostFromPersistence]);
        queryStub.onSecondCall().resolves([boostStatusCount, boostStatusCount]);
        const excludedTypeCategories = [];

        const resultOfListing = await rds.listBoosts(excludedTypeCategories, false, false);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedBoostResult, expectedBoostResult]);
        expect(queryStub).to.have.been.calledWith(...firstQueryArgs);
        expect(queryStub).to.have.been.calledWith(...secondQueryArgs);
    });

    it('Handles excluded type categories', async () => {
        const firstQueryArgs = [
            `select * from ${boostMainTable} where (boost_type || '::' || boost_category) not in ($1) order by creation_time desc`,
            ['REFERRAL::USER_CODE_USED']
        ];
        const secondQueryArgs = [`select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`, []];
        queryStub.withArgs(...firstQueryArgs).resolves([boostFromPersistence, boostFromPersistence]);
        queryStub.withArgs(...secondQueryArgs).resolves([boostStatusCount, boostStatusCount]);
        const excludedTypeCategories = ['REFERRAL::USER_CODE_USED'];

        const resultOfListing = await rds.listBoosts(excludedTypeCategories, false, false);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.deep.equal([expectedBoostResult, expectedBoostResult]);
        expect(queryStub).to.have.been.calledWith(...firstQueryArgs);
        expect(queryStub).to.have.been.calledWith(...secondQueryArgs);
    });

    it('Excludes inactive boosts', async () => {
        const expectedQuery = `select * from ${boostMainTable} where active = true and end_time > current_timestamp ` + 
            `and (boost_type || '::' || boost_category) not in ($1) order by creation_time desc`; 
        const firstQueryArgs = [expectedQuery, ['REFERRAL::USER_CODE_USED']];
        const secondQueryArgs = [
            `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`,
            []
        ];
        queryStub.onFirstCall().resolves([boostFromPersistence, boostFromPersistence]);
        queryStub.onSecondCall().resolves([boostStatusCount, boostStatusCount]);
        const excludedTypeCategories = ['REFERRAL::USER_CODE_USED'];

        const resultOfListing = await rds.listBoosts(excludedTypeCategories, false, true);
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
        'initial_status': 'PENDING'
    };

    beforeEach(() => {
        testHelper.resetStubs(queryStub);
    });

    it('Fetches user boosts', async () => {
        queryStub.resolves([boostFromPersistence, boostFromPersistence]);

        const expectedColumns = [
            `boost_data.boost.boost_id`, 'boost_status', 'label', 'start_time', 'end_time', 'active',
            'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
            'status_conditions', 'message_instruction_ids', 'game_params'
        ];
    
        const selectBoostQuery = `select ${expectedColumns} from boost_data.boost inner join boost_data.boost_account_status ` + 
            `on boost_data.boost.boost_id = boost_data.boost_account_status.boost_id where account_id = $1 and ` + 
            `boost_status not in ($2) and boost_type not in ($3)  ` +
            `order by boost_data.boost_account_status.creation_time desc`;

         const expectedValues = [testAccountId, 'CREATED', 'REFERRAL'];

        const result = await rds.fetchUserBoosts(testAccountId);
        expect(result).to.deep.equal([camelizeKeys(boostFromPersistence), camelizeKeys(boostFromPersistence)]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectBoostQuery, expectedValues);
    });

    it('Fetches recently changed boosts', async () => {
        queryStub.resolves([boostFromPersistence]);
        const dummyTime = moment().subtract(2, 'minutes');

        const expectedColumns = [
            `boost_data.boost.boost_id`, 'boost_status', 'label', 'start_time', 'end_time', 'active',
            'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
            'status_conditions', 'message_instruction_ids', 'game_params'
        ];
    
        const selectBoostQuery = `select ${expectedColumns} from boost_data.boost inner join boost_data.boost_account_status ` + 
            `on boost_data.boost.boost_id = boost_data.boost_account_status.boost_id where account_id = $1 and ` + 
            `boost_status not in ($2, $3, $4) and boost_type not in ($5) and boost_data.boost_account_status.updated_time > $6 ` +
            `order by boost_data.boost_account_status.creation_time desc`;
         const expectedValues = [testAccountId, 'CREATED', 'OFFERED', 'EXPIRED', 'REFERRAL', dummyTime.format()];

        const result = await rds.fetchUserBoosts(testAccountId, dummyTime, ['CREATED', 'OFFERED', 'EXPIRED']);
   
        expect(result).to.exist;
        expect(result).to.deep.equal([camelizeKeys(boostFromPersistence)]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectBoostQuery, expectedValues);
    });

    it('Finds user accounts', async () => {
        queryStub.resolves([{ 'account_id': uuid() }, { 'account_id': uuid() }]);

        const result = await rds.findAccountsForUser(testUserId);
        logger('Got user accounts:', result);
    });
});
