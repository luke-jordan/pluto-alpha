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
        'boostAudienceType', 'audienceId', 'initialStatus', 'statusConditions', 'messageInstructionIds', 'flags'];
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
            initialStatus: 'PENDING',
            statusConditions: testStatusCondition,
            messageInstructionIds: { instructions: [testInstructionId, testInstructionId] },
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
            initialStatus: 'OFFERED',
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

    it('Handles initial status unlocked properly', async () => {    
        queryStub.onFirstCall().resolves([{ 'account_id': 'account-1' }, { 'account_id': 'account-2' }]);
        uuidStub.onFirstCall().returns(testBoostId);

        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': moment().format() }],
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const testInstruction = {
            creatingUserId: 'some-user',
            label: 'Midweek tile match!',
            boostType: 'GAME',
            boostCategory: 'MATCH_TILES',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: moment(),
            boostEndTime: moment().add(1, 'day'),
            defaultStatus: 'UNLOCKED',
            statusConditions: { REDEEMED: 'number_taps_greater' },
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            messageInstructionIds: [],
            gameParams: { gameType: 'MATCH_TILES' } 
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);
        expect(resultOfInsertion).to.exist;

        // first, the instruction to insert the overall boost
        const expectedFirstRow = {
            boostId: testBoostId,
            creatingUserId: 'some-user',
            label: 'Midweek tile match!',
            startTime: testInstruction.boostStartTime.format(),
            endTime: testInstruction.boostEndTime.format(),
            boostType: 'GAME',
            boostCategory: 'MATCH_TILES',
            boostAmount: 100000,
            boostBudget: 200000,
            boostRedeemed: 0,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_float',
            forClientId: 'some_client_co',
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            initialStatus: 'UNLOCKED',
            statusConditions: { REDEEMED: 'number_taps_greater' },
            messageInstructionIds: { instructions: [] },
            gameParams: { gameType: 'MATCH_TILES' }
        };

        const expectedKeys = Object.keys(expectedFirstRow);
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(expectedKeys)}) values %L returning boost_id, creation_time`;
        const expectedColumnTemplate = extractColumnTemplate(expectedKeys);
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: expectedColumnTemplate, rows: [expectedFirstRow]};

        const expectedSecondQuery = `insert into ${boostUserTable} (${extractQueryClause(boostUserKeys)}) values %L returning insertion_id, creation_time`;
        const expectedJoinTableRows = [
            { boostId: testBoostId, accountId: 'account-1', boostStatus: 'UNLOCKED' },
            { boostId: testBoostId, accountId: 'account-2', boostStatus: 'UNLOCKED' }
        ];
        const expectedSecondDef = { query: expectedSecondQuery, columnTemplate: extractColumnTemplate(boostUserKeys), rows: expectedJoinTableRows};
        
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
            boostAudienceType: 'EVENT_DRIVEN',
            audienceId: testAudienceId,
            initialStatus: null,
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
            defaultStatus: null, // this has meaning here, in sense of there is no such thing (is determing by event/combination thereof)
            statusConditions: mockCreateConditions,
            boostAudienceType: 'EVENT_DRIVEN',
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
        expect(queryStub).to.not.have.been.called;
    });

    it('Same thing, but with event type and default status set to UNLOCKED', async () => {
        // most of this is irrelevant, just checking the important
        const mockCreateConditions = {
            REDEEMED: ['number_taps_greater_than_N #{20:20000}']
        };
    
        uuidStub.onFirstCall().returns(testBoostId);

        // this is not great but Sinon matching is just the worst thing in the world and is failing abysmally on complex matches, hence
        const insertionTime = moment();
        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }]
        ]);

        const testInstruction = {
            creatingUserId: 'admin-user-id',
            label: 'Midweek arrow chase!',
            boostType: 'GAME',
            boostCategory: 'CHASE_THE_ARROW',
            boostAudienceType: 'EVENT_DRIVEN',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: moment(),
            boostEndTime: moment().add(1, 'week'),
            defaultStatus: 'UNLOCKED',
            statusConditions: mockCreateConditions,
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            messageInstructionIds: []
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);
        expect(resultOfInsertion.accountIds).to.deep.equal([]);

        expect(multiTableStub).to.have.been.calledOnce;
        expect(multiTableStub.getCall(0).args[0]).to.have.length(1);
        expect(queryStub).to.not.have.been.called;
    });

    it('Inserts ML parameters properly', async () => {
        
        uuidStub.onFirstCall().returns(testBoostId);

        // as per note above
        const insertionTime = moment();
        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }]
        ]);

        const mockMlParameters = {
            onlyOfferOnce: false, minIntervalBetweenRuns: { value: 7, unit: 'days' }
        };

        const mockExpiryParams = {
            individualizedExpiry: true, timeUntilExpiry: { unit: 'hours', value: 24 }
        };

        const testInstruction = {
            creatingUserId: 'admin-user-id',
            label: 'Midweek arrow chase!',
            boostType: 'GAME',
            boostCategory: 'CHASE_THE_ARROW',
            boostAudienceType: 'EVENT_DRIVEN',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: moment(),
            boostEndTime: moment().add(1, 'week'),
            defaultStatus: 'CREATED',
            statusConditions: { REDEEMED: ['number_taps_greater_than_N #{20:20000}'] },
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            mlParameters: mockMlParameters,
            expiryParameters: mockExpiryParams,
            messageInstructionIds: []
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);
        expect(resultOfInsertion.accountIds).to.deep.equal([]);

        expect(multiTableStub).to.have.been.calledOnce;
        expect(multiTableStub.getCall(0).args[0]).to.have.length(1);
        
        const persistedBoostQueryDef = multiTableStub.getCall(0).args[0][0];

        const persistedBoost = persistedBoostQueryDef.rows[0];
        expect(persistedBoost).to.have.property('mlParameters', mockMlParameters);

        expect(queryStub).to.not.have.been.called;
    });

    it('Inserts boost-account joins', async () => {
        const testBoostStatus = 'CREATED';
        const testCreationTime = moment().format();

        const insertBoostQuery = `insert into ${boostUserTable} (boost_id, account_id, boost_status) values %L returning insertion_id, creation_time`;
        const columnTemplate = '${boostId}, ${accountId}, ${boostStatus}';
        const boostRow = { boostId: testBoostId, accountId: testAccountId, boostStatus: testBoostStatus };
    
        const boostQueryDef = { query: insertBoostQuery, columnTemplate, rows: [boostRow, boostRow, boostRow, boostRow] };

        multiTableStub.resolves([
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const expectedResult = { boostIds: [testBoostId, testBoostId], accountIds: [testAccountId, testAccountId], persistedTimeMillis: moment(testCreationTime).valueOf() };

        const resultOfInsertion = await rds.insertBoostAccountJoins([testBoostId, testBoostId], [testAccountId, testAccountId], testBoostStatus);

        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.deep.equal(expectedResult);
        expect(multiTableStub).to.have.been.calledOnceWithExactly([boostQueryDef]);
    });

    it('Includes expiry time in joins, if passed', async () => {
        const testBoostStatus = 'OFFERED';
        const expiryMoment = moment().add(24, 'hours');

        const expectedQuery = `insert into ${boostUserTable} (boost_id, account_id, boost_status, expiry_time) values %L returning insertion_id, creation_time`;
        const expectedColumns = '${boostId}, ${accountId}, ${boostStatus}, ${expiryTime}';
        const expectedRow = (accountId) => ({ boostId: testBoostId, accountId, boostStatus: testBoostStatus, expiryTime: expiryMoment.format() });
    
        const boostQueryDef = { 
            query: expectedQuery, 
            columnTemplate: expectedColumns, 
            rows: [expectedRow('account-1'), expectedRow('account-2')] 
        };

        multiTableStub.resolves([[{ 'creation_time': moment().format() }, { 'creation_time': moment().format() }]]);

        const resultOfInsertion = await rds.insertBoostAccountJoins([testBoostId], ['account-1', 'account-2'], testBoostStatus, expiryMoment);

        expect(resultOfInsertion).to.exist; // format is tested above
        expect(multiTableStub).to.have.been.calledOnceWithExactly([boostQueryDef]);
    });

});
