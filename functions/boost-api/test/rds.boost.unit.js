'use strict';

const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');
const decamelize = require('decamelize');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const proxyquire = require('proxyquire').noCallThru();

const queryStub = sinon.stub();
const multiTableStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.largeMultiTableInsert = multiTableStub;
    }
}

const rds = proxyquire('../persistence/rds.boost', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(queryStub, multiTableStub, uuidStub);
const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

const boostTable = config.get('tables.boostTable');
const boostUserTable = config.get('tables.boostAccountJoinTable');

describe('*** UNIT TEST BOOSTS RDS *** Inserting boost instruction and boost-user records', () => {

    const testBoostId = uuid();
    const testAccountId = uuid();
    const testAudienceId = uuid();
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testRedemptionMsgs = [{ accountId: 'ALL', msgInstructionId: uuid() }];

    const standardBoostKeys = ['boostId', 'creatingUserId', 'label', 'startTime', 'endTime', 'boostType', 'boostCategory', 'boostAmount', 
        'boostBudget', 'boostRedeemed', 'boostUnit', 'boostCurrency', 'fromBonusPoolId', 'fromFloatId', 'forClientId', 
        'boostAudienceType', 'audienceId', 'statusConditions', 'messageInstructionIds', 'conditionValues', 'flags'];
    const boostUserKeys = ['boostId', 'accountId', 'boostStatus'];
    
    beforeEach(() => (resetStubs()));

    it('Insert a referral code and construct the two entry logs', async () => {

        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testInstructionId = uuid();
        const testCreatingUserId = uuid();
        const testReferringAccountId = uuid();
        const testReferredUserAccountId = uuid();

        const relevantUsers = [testReferringAccountId, testReferredUserAccountId];

        // first, obtain the audience & generate a UID
        queryStub.onFirstCall().resolves([{ 'account_id': testReferringAccountId }, { 'account_id': testReferredUserAccountId }]);
        uuidStub.onFirstCall().returns(testBoostId);

        // then, construct the simultaneous insert operations
        // first, the instruction to insert the overall boost
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(standardBoostKeys)}) values %L returning boost_id, creation_time`;
        const expectedFirstRow = {
            boostId: testBoostId,
            label: 'Referral Code Boost!',
            creatingUserId: testCreatingUserId,
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostBudget: 200000, // i.e., twice the amount
            boostRedeemed: 0,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_float',
            forClientId: 'some_client_co',
            boostAudienceType: 'INDIVIDUAL',
            audienceId: testAudienceId,
            statusConditions: testStatusCondition,
            messageInstructionIds: { instructions: [testInstructionId, testInstructionId] },
            conditionValues: ['TEST_VALUE'],
            flags: ['TEST_FLAG']
        };
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: extractColumnTemplate(standardBoostKeys), rows: [expectedFirstRow]};

        // then, the instruction for the user - boost join entries
        const expectedSecondQuery = `insert into ${boostUserTable} (${extractQueryClause(boostUserKeys)}) values %L returning insertion_id, creation_time`;
        const expectedJoinTableRows = [
            { boostId: testBoostId, accountId: testReferringAccountId, boostStatus: 'PENDING' },
            { boostId: testBoostId, accountId: testReferredUserAccountId, boostStatus: 'PENDING' }
        ];
        const expectedSecondDef = { query: expectedSecondQuery, columnTemplate: extractColumnTemplate(boostUserKeys), rows: expectedJoinTableRows};

        // then transact them
        const insertionTime = moment();
        // this is not great but Sinon matching is just the worst thing in the world and is failing abysmally on complex matches, hence
        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }],
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const testInstruction = {
            creatingUserId: testCreatingUserId,
            label: 'Referral Code Boost!',
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            statusConditions: testStatusCondition,
            boostAudienceType: 'INDIVIDUAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            messageInstructionIds: [testInstructionId, testInstructionId],
            defaultStatus: 'PENDING',
            conditionValues: true,
            conditionClause: ['TEST_VALUE'],
            flags: ['TEST_FLAG']
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);

        // then respond with the number of users, and the boost ID itself, along with when it was persisted (given psql limitations, to nearest second)
        const expectedMillis = insertionTime.startOf('second').valueOf();
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('boostId', testBoostId);
        expect(resultOfInsertion).to.have.property('persistedTimeMillis', expectedMillis);
        expect(resultOfInsertion).to.have.property('numberOfUsersEligible', relevantUsers.length);

        const expectedAccountIds = [testReferringAccountId, testReferredUserAccountId]; // property match fails spuriously 
        expect(resultOfInsertion.accountIds).to.deep.equal(expectedAccountIds);

        const expectedSelectQuery = `select account_id from ${config.get('tables.audienceJoinTable')} where audience_id = $1 and active = $2`;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedSelectQuery, [testAudienceId, true]);

        expect(multiTableStub).to.have.been.calledOnce;
        const multiTableArgs = multiTableStub.getCall(0).args[0];
        expect(multiTableArgs[1]).to.deep.equal(expectedSecondDef);
        expect(multiTableArgs[0]).to.deep.equal(insertFirstDef);
    });

    it('Insert a game based boost and construct the two entry logs', async () => {
        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testInstructionId = uuid();
        const testCreatingUserId = uuid();
        const testEligibleAccountId = uuid();
        const testSecondAccountId = uuid();

        const relevantUsers = [testEligibleAccountId, testSecondAccountId];

        const testGameParams = {
            gameType: 'CHASE_ARROW',
            timeLimitSeconds: 20,
            winningThreshold: 20,
            instructionBand: 'Tap the screen as many times as you can in 20 seconds',
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
        };
    
        // first, obtain the audience & generate a UID
        queryStub.onFirstCall().resolves([{ 'account_id': testEligibleAccountId }, { 'account_id': testSecondAccountId }]);
        uuidStub.onFirstCall().returns(testBoostId);

        // then, construct the simultaneous insert operations
        // first, the instruction to insert the overall boost
        const expectedFirstRow = {
            boostId: testBoostId,
            creatingUserId: testCreatingUserId,
            label: 'Midweek arrow chase!',
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'GAME',
            boostCategory: 'CHASE_THE_ARROW',
            boostAmount: 100000,
            boostBudget: 200000, // i.e., twice the amount
            boostRedeemed: 0,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_float',
            forClientId: 'some_client_co',
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            statusConditions: testStatusCondition,
            messageInstructionIds: { instructions: [testInstructionId, testInstructionId] },
            gameParams: testGameParams
        };

        const expectedKeys = Object.keys(expectedFirstRow);
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(expectedKeys)}) values %L returning boost_id, creation_time`;
        const expectedColumnTemplate = extractColumnTemplate(expectedKeys);
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: expectedColumnTemplate, rows: [expectedFirstRow]};

        // then, the instruction for the user - boost join entries
        const expectedSecondQuery = `insert into ${boostUserTable} (${extractQueryClause(boostUserKeys)}) values %L returning insertion_id, creation_time`;
        const expectedJoinTableRows = [
            { boostId: testBoostId, accountId: testEligibleAccountId, boostStatus: 'OFFERED' },
            { boostId: testBoostId, accountId: testSecondAccountId, boostStatus: 'OFFERED' }
        ];
        const expectedSecondDef = { query: expectedSecondQuery, columnTemplate: extractColumnTemplate(boostUserKeys), rows: expectedJoinTableRows};

        // then transact them
        const insertionTime = moment();
        // this is not great but Sinon matching is just the worst thing in the world and is failing abysmally on complex matches, hence
        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }],
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const testInstruction = {
            creatingUserId: testCreatingUserId,
            label: 'Midweek arrow chase!',
            boostType: 'GAME',
            boostCategory: 'CHASE_THE_ARROW',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            defaultStatus: 'OFFERED',
            statusConditions: testStatusCondition,
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            messageInstructionIds: [testInstructionId, testInstructionId],
            gameParams: testGameParams 
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);

        // then respond with the number of users, and the boost ID itself, along with when it was persisted (given psql limitations, to nearest second)
        const expectedMillis = insertionTime.startOf('second').valueOf();
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('boostId', testBoostId);
        expect(resultOfInsertion).to.have.property('persistedTimeMillis', expectedMillis);
        expect(resultOfInsertion).to.have.property('numberOfUsersEligible', relevantUsers.length);

        const expectedAccountIds = [testEligibleAccountId, testSecondAccountId]; // property match fails spuriously 
        expect(resultOfInsertion.accountIds).to.deep.equal(expectedAccountIds);

        const expectedSelectQuery = `select account_id from ${config.get('tables.audienceJoinTable')} where audience_id = $1 and active = $2`;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedSelectQuery, [testAudienceId, true]);

        expect(multiTableStub).to.have.been.calledOnce;
        const multiTableArgs = multiTableStub.getCall(0).args[0];
        expect(multiTableArgs[1]).to.deep.equal(expectedSecondDef);
        expect(multiTableArgs[0]).to.deep.equal(insertFirstDef);
    });

    it('Inserts event-based boost without inserting account records', async () => {
        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testInstructionId = uuid();
        const testCreatingUserId = uuid();

        const mockCreateConditions = {
            UNLOCKED: ['event_occurs #{USER_CREATED_ACCOUNT}'],
            REDEEMED: ['number_taps_greater_than_N #{20:20000}']
        };

        const testGameParams = {
            gameType: 'CHASE_ARROW',
            timeLimitSeconds: 20,
            winningThreshold: 20,
            instructionBand: 'Tap the screen as many times as you can in 20 seconds'
        };
    
        uuidStub.onFirstCall().returns(testBoostId);

        const expectedFirstRow = {
            boostId: testBoostId,
            creatingUserId: testCreatingUserId,
            label: 'Midweek arrow chase!',
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'GAME',
            boostCategory: 'CHASE_THE_ARROW',
            boostAmount: 100000,
            boostBudget: 200000, // i.e., twice the amount
            boostRedeemed: 0,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_float',
            forClientId: 'some_client_co',
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            statusConditions: mockCreateConditions,
            messageInstructionIds: { instructions: [testInstructionId, testInstructionId] },
            gameParams: testGameParams
        };

        const expectedKeys = Object.keys(expectedFirstRow);
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(expectedKeys)}) values %L returning boost_id, creation_time`;
        const expectedColumnTemplate = extractColumnTemplate(expectedKeys);
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: expectedColumnTemplate, rows: [expectedFirstRow]};

        // then transact them
        const insertionTime = moment();
        // this is not great but Sinon matching is just the worst thing in the world and is failing abysmally on complex matches, hence
        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }]
        ]);

        const testInstruction = {
            creatingUserId: testCreatingUserId,
            label: 'Midweek arrow chase!',
            boostType: 'GAME',
            boostCategory: 'CHASE_THE_ARROW',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            defaultStatus: 'UNCREATED',
            statusConditions: mockCreateConditions,
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            messageInstructionIds: [testInstructionId, testInstructionId],
            gameParams: testGameParams 
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);

        // then respond with the number of users, and the boost ID itself, along with when it was persisted (given psql limitations, to nearest second)
        const expectedMillis = insertionTime.startOf('second').valueOf();
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('boostId', testBoostId);
        expect(resultOfInsertion).to.have.property('persistedTimeMillis', expectedMillis);

        expect(resultOfInsertion.accountIds).to.deep.equal([]);

        expect(multiTableStub).to.have.been.calledOnceWithExactly([insertFirstDef]);
    });

    it('Inserts boost-account', async () => {
        const testBoostStatus = 'CREATED';
        const testCreationTime = moment().format();

        const insertBoostQuery = `insert into ${boostUserTable} (boost_id, account_id, boost_status) values %L returning insertion_id, creation_time`;
        const columnTemplate = '${boostId}, ${accountId}, ${boostStatus}';
        const boostRow = { boostId: testBoostId, accountId: testAccountId, boostStatus: testBoostStatus };
    
        const boostQueryDef = { query: insertBoostQuery, columnTemplate, rows: [boostRow, boostRow] };

        multiTableStub.resolves([
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const expectedResult = { boostIds: [testBoostId, testBoostId], accountId: testAccountId, persistedTimeMillis: moment(testCreationTime).valueOf() };

        const resultOfInsertion = await rds.insertBoostAccount([testBoostId, testBoostId], testAccountId, testBoostStatus);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.deep.equal(expectedResult);
        expect(multiTableStub).to.have.been.calledOnceWithExactly([boostQueryDef]);
    });

    it('Fetches account ids for pooled rewards', async () => {
        const logType = 'BOOST_POOL_CONTRIBUTION';
        const selectQuery = `select distinct account_id from boost_data.boost_log where log_type = $1`;
        queryStub.resolves([{ 'account_id': 'account-1' }, { 'account_id': 'account-2' }]);

        const result = await rds.findAccountsForPooledReward(logType);
        expect(result).to.deep.equal(['account-1', 'account-2']);

        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [logType]);
    });
});
