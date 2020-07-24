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

const rds = proxyquire('../persistence/rds.boost.list', {
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
        'boost_category': 'SIMPLE_SAVE',
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
        boostCategory: 'SIMPLE_SAVE',
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
    const testStatusUpdatedTime = moment();
    
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };

    const boostFromPersistence = {
        'creating_user_id': testUserId,
        'boost_id': testBoostId,
        'boost_type': 'SIMPLE',
        'label': 'SDFSDF',
        'boost_category': 'SIMPLE_SAVE',
        'boost_amount': 100000,
        'boost_unit': 'HUNDREDTH_CENT',
        'active': true,
        'boost_currency': 'USD',
        'from_float_id': 'primary_cash',
        'for_client_id': 'some_client_co',
        'start_time': testStartTime.format(),
        'end_time': testEndTime.format(),
        'updated_time': testStatusUpdatedTime.format(),
        'status_conditions': testStatusCondition,
        'initial_status': 'PENDING'
    };

    beforeEach(() => {
        testHelper.resetStubs(queryStub);
    });

    it('Fetches user boosts', async () => {
        queryStub.resolves([boostFromPersistence, boostFromPersistence]);

        const expectedColumns = [
            `boost_data.boost.boost_id`, 'boost_status', 'label', 'start_time', 'end_time', 'boost_data.boost_account_status.updated_time', 
            'active', 'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
            'status_conditions', 'message_instruction_ids', 'game_params', 'reward_parameters', 'boost_data.boost.flags'
        ];
    
        const selectBoostQuery = `select ${expectedColumns} from boost_data.boost inner join boost_data.boost_account_status ` + 
            `on boost_data.boost.boost_id = boost_data.boost_account_status.boost_id where account_id = $1 and ` + 
            `boost_status not in ($2) and boost_type not in ($3) ` +
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
            `boost_data.boost.boost_id`, 'boost_status', 'label', 'start_time', 'end_time', 'boost_data.boost_account_status.updated_time', 'active',
            'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
            'status_conditions', 'message_instruction_ids', 'game_params', 'reward_parameters', 'boost_data.boost.flags'
        ];
    
        const selectBoostQuery = `select ${expectedColumns} from boost_data.boost inner join boost_data.boost_account_status ` + 
            `on boost_data.boost.boost_id = boost_data.boost_account_status.boost_id where account_id = $1 and ` + 
            `boost_status not in ($2, $3, $4) and boost_type not in ($5) and boost_data.boost_account_status.updated_time > $6 ` +
            `order by boost_data.boost_account_status.creation_time desc`;
         const expectedValues = [testAccountId, 'CREATED', 'OFFERED', 'EXPIRED', 'REFERRAL', dummyTime.format()];

        const result = await rds.fetchUserBoosts(testAccountId, { changedSinceTime: dummyTime, excludedStatus: ['CREATED', 'OFFERED', 'EXPIRED'] });
   
        expect(result).to.exist;
        expect(result).to.deep.equal([camelizeKeys(boostFromPersistence)]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectBoostQuery, expectedValues);
    });

    it('Fetches only boost with specific flag', async () => {
        queryStub.resolves([boostFromPersistence]);

        const expectedColumns = [
            `boost_data.boost.boost_id`, 'boost_status', 'label', 'start_time', 'end_time', 'boost_data.boost_account_status.updated_time', 'active',
            'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
            'status_conditions', 'message_instruction_ids', 'game_params', 'reward_parameters', 'boost_data.boost.flags'
        ];
    
        const selectBoostQuery = `select ${expectedColumns} from boost_data.boost inner join boost_data.boost_account_status ` + 
            `on boost_data.boost.boost_id = boost_data.boost_account_status.boost_id where account_id = $1 and ` + 
            `boost_status not in ($2, $3, $4, $5) and boost_type not in ($6) and boost_data.boost.flags && $7 ` +
            `order by boost_data.boost_account_status.creation_time desc`;

         const expectedValues = [testAccountId, 'REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED', 'REFERRAL', ['FRIEND_TOURNAMENT']];
        
        const fetchParams = { excludedStatus: ['REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED'], flags: ['FRIEND_TOURNAMENT'] };
        const result = await rds.fetchUserBoosts(testAccountId, fetchParams);

        expect(result).to.deep.equal([camelizeKeys(boostFromPersistence)]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectBoostQuery, expectedValues);
    });

    it('Finds user accounts', async () => {
        queryStub.resolves([{ 'account_id': uuid() }, { 'account_id': uuid() }]);

        const result = await rds.findAccountsForUser(testUserId);
        logger('Got user accounts:', result);
    });

    it('Fetches logs appropriately', async () => {
        queryStub.resolves([{ 'log_id': 'log1', 'log_type': 'GAME_OUTCOME', 'account_id': 'account-1', 'boost_id': 'boost-1' }]);

        const result = await rds.fetchUserBoostLogs('account-1', ['boost-1'], 'GAME_OUTCOME');
        expect(result).to.deep.equal([{ logId: 'log1', logType: 'GAME_OUTCOME', accountId: 'account-1', boostId: 'boost-1' }]);

        const expectedQuery = `select * from boost_data.boost_log where account_id = $1 and log_type = $2 and boost_id in ($3)`;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['account-1', 'GAME_OUTCOME', 'boost-1']);
    });

    it('Fetches boost along with account IDs and user IDs properly', async () => {
        const expectedBoostQuery = 'select * from boost_data.boost where boost_id = $1';
        const expectedAccountQuery = 'select account_id from boost_data.boost_account_status where boost_id = $1';
        
        queryStub.onFirstCall().resolves([{
            'boost_id': testBoostId, 
            'boost_type': 'GAME', 
            'boost_category': 'DESTROY_IMAGE',
            'label': 'This is a boost', 
            'active': true, 
            'creating_user_id': 'do-not-return', 
            'start_time': testStartTime.format(), 
            'end_time': testEndTime.format(),
            'status_conditions': { REDEEMED: ['something'] }, 
            'reward_parameters': { rewardType: 'POOLED' },
            'boost_amount': 100, 
            'boost_unit': 
            'WHOLE_CURRENCY', 
            'boost_currency': 'ZAR',
            'flags': ['FRIEND_TOURNAMENT']
        }]);

        queryStub.onSecondCall().resolves([
            { 'account_id': 'account-1' }, { 'account_id': 'account-2' }
        ]);

        const fetchedBoost = await rds.fetchBoostDetails(testBoostId, true);
        expect(fetchedBoost).to.deep.equal({
            boostId: testBoostId, 
            boostType: 'GAME',
            boostCategory: 'DESTROY_IMAGE',
            label: 'This is a boost', 
            active: true, 
            startTime: moment(testStartTime.format()), 
            endTime: moment(testEndTime.format()),
            statusConditions: { REDEEMED: ['something'] }, 
            rewardParameters: { rewardType: 'POOLED' },
            boostAmount: { amount: 100, unit: 'WHOLE_CURRENCY', currency: 'ZAR' },
            flags: ['FRIEND_TOURNAMENT'],
            accountIds: ['account-1', 'account-2']
        });

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(expectedBoostQuery, [testBoostId]);
        expect(queryStub).to.have.been.calledWithExactly(expectedAccountQuery, [testBoostId]);
    });

    it('Does not fetch accounts if not asked', async () => {

        queryStub.onFirstCall().resolves([{
            'boost_id': testBoostId,
            'boost_type': 'SOCIAL',
            'boost_category': 'FRIENDS_ADDED', 
            'label': 'This is a boost', 
            'active': true, 
            'start_time': testStartTime.format(), 
            'end_time': testEndTime.format(),
            'status_conditions': { REDEEMED: ['something'] },
            'boost_amount': 100, 
            'boost_unit': 'WHOLE_CURRENCY', 
            'boost_currency': 'ZAR'
        }]);

        const fetchedBoost = await rds.fetchBoostDetails(testBoostId);
        expect(fetchedBoost).to.deep.equal({
            boostId: testBoostId, 
            boostType: 'SOCIAL',
            boostCategory: 'FRIENDS_ADDED',
            label: 'This is a boost', 
            active: true, 
            startTime: moment(testStartTime.format()), 
            endTime: moment(testEndTime.format()),
            statusConditions: { REDEEMED: ['something'] }, 
            rewardParameters: {},
            boostAmount: { amount: 100, unit: 'WHOLE_CURRENCY', currency: 'ZAR' },
            flags: []
        });

        expect(queryStub).to.have.been.calledOnce;
        expect(queryStub).to.have.been.calledWithExactly('select * from boost_data.boost where boost_id = $1', [testBoostId]);
    });

    it('Fetches friend tournament logs appropriately', async () => {
        const expectedQuery = `select boost_data.boost_log.log_context, account_data.core_account_ledger.owner_user_id from ` +
            `boost_data.boost_log inner join account_data.core_account_ledger on ` +
            `boost_data.boost_log.account_id = account_data.core_account_ledger.account_id where ` +
            `boost_id = $1 and log_type = $2`;

        const mockRow = (userId, percentDestroyed) => ({
            'owner_user_id': userId,
            'log_context': { percentDestroyed } 
        });
        queryStub.resolves([mockRow('user-1', 45), mockRow('user-2', 65), mockRow('user-3', 25)]);

        const tournamentScores = await rds.fetchBoostScoreLogs(testBoostId);
        expect(tournamentScores).to.deep.equal([
            { userId: 'user-1', gameScore: 45 },
            { userId: 'user-2', gameScore: 65 },
            { userId: 'user-3', gameScore: 25}
        ]);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, [testBoostId, 'GAME_RESPONSE']);
    });

    it('Sums boost and saved amounts', async () => {
        const sumQuery = `select boost_id, sum(cast(log_context->>'boostAmount' as bigint)) as boost_amount, ` +
            `sum(cast(log_context->>'savedWholeCurrency' as bigint)) as saved_whole_currency from ` +
            `boost_data.boost_log where log_context ->> 'newStatus' = $1 and ` + 
            `log_context ->> 'boostAmount' ~ E'^\\\\d+$' and log_context ->> 'savedWholeCurrency' ~ E'^\\\\d+$'` + 
            `boost_id in ($2, $3) group by boost_id`;
            
        queryStub.resolves([
            { 'boost_id': 'boost-id-1', 'boost_amount': 10000, 'saved_whole_currency': 100 },
            { 'boost_id': 'boost-id-2', 'boost_amount': 20000, 'saved_whole_currency': 200 }
        ]);

        const testBoostIds = ['boost-id-1', 'boost-id-2'];

        const resultOfSum = await rds.sumBoostAndSavedAmounts(testBoostIds);
        expect(resultOfSum).to.exist;

        const expectedResult = [
            { boostId: 'boost-id-1', boostAmount: 10000, savedWholeCurrency: 100 },
            { boostId: 'boost-id-2', boostAmount: 20000, savedWholeCurrency: 200 }
        ];
        expect(resultOfSum).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(sumQuery, ['REDEEMED', 'boost-id-1', 'boost-id-2']);
    });
});
