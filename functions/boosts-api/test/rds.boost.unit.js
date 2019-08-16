'use strict';

const logger = require('debug')('jupiter:boosts:rds-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');
const decamelize = require('decamelize');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const rds = proxyquire('../persistence/rds.boost', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(queryStub, insertStub, multiTableStub, multiOpStub);

const accountTable = config.get('tables.accountLedger');
const boostTable = config.get('tables.boostTable');
const boostUserTable = config.get('tables.boostAccountJoinTable');
const boostLogTable = config.get('tables.boostLogTable');

describe('*** UNIT TEST BOOSTS RDS *** Inserting boost instruction and boost-user records', () => {

    const testBoostId = uuid();

    const audienceQueryBase = `select account_id from ${accountTable}`;

    const standardBoostKeys = ['boostId', 'startTime', 'endTime', 'boostType', 'boostCategory', 'boostAmount', 'boostUnit', 'boostCurrency', 
        'fromBonusPoolId', 'forClientId', 'boostAudience', 'audienceSelection', 'conditionClause'];
    const boostUserKeys = ['boostId', 'accountId', 'status'];
    
    const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
    const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

    beforeEach(() => (resetStubs()));

    // todo : also add the logs
    it('Insert a referral code and construct the two entry logs', async () => {

        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testReferringAccountId = uuid();
        const testReferredUserAccountId = uuid();
        const relevantUsers = [testReferringAccountId, testReferredUserAccountId];

        logger('Here we go');

        // first, obtain the audience & generate a UID
        const expectedSelectQuery = `${audienceQueryBase} where account_id in ($1, $2)`;
        queryStub.withArgs(expectedSelectQuery, sinon.match(relevantUsers)).resolves([ 
            { 'account_id': testReferringAccountId }, { 'account_id': testReferredUserAccountId }
        ]);

        uuidStub.onFirstCall().returns(testBoostId);

        // then, construct the simultaneous insert operations
        // first, the instruction to insert the overall boost
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(standardBoostKeys)}) values %L returning boost_id, creation_time`;
        const expectedFirstRow = {
            boostId: testBoostId,
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            boostAudience: 'INDIVIDUAL',
            audienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
            conditionClause: `save_completed_by #{${testReferredUserAccountId}}`
        };
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: extractColumnTemplate(standardBoostKeys), rows: [expectedFirstRow]};

        // then, the instruction for the user - boost join entries
        const expectedSecondQuery = `insert into ${boostUserTable} (${extractQueryClause(boostUserKeys)}) values %L returning insertion_id, creation_time`;
        const expectedJoinTableRows = [
            { boostId: testBoostId, accountId: testReferringAccountId, status: 'PENDING' },
            { boostId: testBoostId, accountId: testReferredUserAccountId, status: 'PENDING' }
        ];
        const expectedSecondDef = { query: expectedSecondQuery, columnTemplate: extractColumnTemplate(boostUserKeys), rows: expectedJoinTableRows};

        // then transact them
        const insertionTime = moment();
        multiTableStub.withArgs([insertFirstDef, expectedSecondDef]).resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }],
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const testInstruction = {
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            conditionClause: `save_completed_by #{${testReferredUserAccountId}}`,
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
            defaultStatus: 'PENDING'
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);

        // then respond with the number of users, and the boost ID itself, along with when it was persisted (given psql limitations, to nearest second)
        const expectedMillis = insertionTime.startOf('second').valueOf();
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('boostId', testBoostId);
        expect(resultOfInsertion).to.have.property('persistedTimeMillis', expectedMillis);
        expect(resultOfInsertion).to.have.property('numberOfUsersEligible', relevantUsers.length);
    });

});

describe('*** UNIT TEST BOOSTS RDS *** Unit test recording boost-user responses / logs', () => {

    const testAccountId = uuid();
    const testBoostId = uuid();

    const testStartTime = moment();
    const testEndTime = moment().add(1, 'week');

    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testAudienceSelection = `whole_universe from #{'{"specific_users": ["${uuid()}","${uuid()}"]}'}`;
    const testRedemptionMsgs = [{ accountId: uuid(), msgInstructionId: uuid() }, { accountId: uuid(), msgInstructionId: uuid() }];

    const updateAccountStatusDef = (boostId, accountId, newStatus) => ({
        table: boostUserTable,
        key: { boostId, accountId },
        value: { status: newStatus },
        returnClause: 'updated_time'
    });

    const logColumns = ['boostId', 'logType', 'accountId', 'logContext'];
    const assembleLogInsertDef = (logRows) => ({
        query: `insert into ${boostLogTable} (${extractQueryClause(logColumns)}) values %L returning insertion_id, creation_time`,
        columnTemplate: extractColumnTemplate(logColumns),
        rows: logRows 
    });

    const boostFromPersistence = {
        'boost_id': testBoostId,
        'boost_type': 'REFERRAL',
        'boost_category': 'USER_CODE_USED',
        'boost_amount': 100000,
        'boost_unit': 'HUNDREDTH_CENT',
        'boost_currency': 'USD',
        'from_bonus_pool_id': 'primary_bonus_pool',
        'from_float_id': 'primary_cash',
        'for_client_id': 'some_client_co',
        'start_time': testStartTime.format(),
        'end_time': testEndTime.format(),
        'status_conditions': JSON.stringify(testStatusCondition),
        'boost_audience': 'INDIVIDUAL',
        'audience_selection':JSON.stringify(testAudienceSelection),
        'redemption_messages': JSON.stringify(testRedemptionMsgs),
        'flags': ['REDEEM_ALL_AT_ONCE']
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
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: testStatusCondition,
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection: testAudienceSelection,
        defaultStatus: 'PENDING',
        redemptionMsgInstructions: testRedemptionMsgs,
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    const generateSimpleBoostFromPersistence = (boostId) => {
        const newBoost = JSON.parse(JSON.stringify(boostFromPersistence));
        newBoost['boost_type'] = 'SIMPLE';
        newBoost['boost_category'] = 'TIME_LIMITED';
        newBoost['flags'] = [];
        newBoost['boost_id'] = boostId;
        return newBoost;
    };

    const generateSimpleExpectedBoost = (boostId) => {
        const newBoost = JSON.parse(JSON.stringify(expectedBoostResult));
        newBoost.boostType = 'SIMPLE';
        newBoost.boostCategory = 'TIME_LIMITED';
        newBoost.flags = [];
        newBoost.boostId = boostId;
        return newBoost;
    };

    const accountUserIdRow = (accountId, userId, boostId = testBoostId) => ({ 'boost_id': boostId, 'account_id': accountId, 'user_id': userId });

    beforeEach(() => resetStubs());

    it('Finds one active boost correctly, assembling query as needed, including current status', async () => {
        const expectedFindBoostQuery = `select boost_id from ${boostUserTable} where account_id in ($1) and status in ($2, $3)`;
        const retrieveBoostDetailsQuery = `select * from ${boostTable} where boost_id in ($1) and active = true`;

        const testInput = {
            accountId: [testAccountId], status: ['OFFERED', 'PENDING'], active: true
        };

        queryStub.withArgs(expectedFindBoostQuery, [testAccountId, 'OFFERED', 'PENDING']).resolves({ 'boost_id': testBoostId });
        queryStub.withArgs(retrieveBoostDetailsQuery, [testBoostId]).resolves([boostFromPersistence]);

        const findBoostResponse = await rds.findBoost(testInput);
        expect(findBoostResponse).to.exist;
        expect(findBoostResponse).to.deep.equal([expectedBoostResult]);
    });

    it('Finds multiple active boosts correctly', async () => {
        const testAccountIds = [uuid(), uuid()];
        const testBoostIds = [uuid(), uuid(), uuid()];

        const boostIdsFromPersistence = testBoostIds.map((boostId) => ({ 'boost_id': boostId }));
        const testBoostsFromPersistence = testBoostIds.map(generateSimpleBoostFromPersistence);
        
        const expectedFindBoostQuery = `select boost_id from ${boostUserTable} where account_id in ($1, $2) and status in $(3)`;
        const retrieveBoostDetailsQuery = `select * from ${boostTable} where boost_id in ($1, $2, $3)`;

        const testInput = { accountId: testAccountIds, status: ['OFFERED'] };
        const expectedResult = testBoostIds.map(generateSimpleExpectedBoost);

        queryStub.withArgs(expectedFindBoostQuery, [testAccountIds[0], testAccountIds[1], 'OFFERED']).resolves(boostIdsFromPersistence);
        queryStub.withArgs(retrieveBoostDetailsQuery, testBoostIds).resolves(testBoostsFromPersistence);

        const findBoostResponse = await rds.findBoost(testInput);
        expect(findBoostResponse).to.exist;
        expect(findBoostResponse).to.be.an('array').of.length(3);
        expect(sinon.match(expectedResult).test(findBoostResponse)).to.be.true;
    });

    // boosts only ever affect (1) all related accounts of a certain current status in relation to that boost, or (2) a specific account
    it('Finds account IDs and user IDs correctly for a boost, find all pending', async () => {
        const testAccountId2 = uuid();
        const [testUserId1, testUserId2] = [uuid(), uuid()];
        const expectedResult = {
            boostId: testBoostId,
            accountUserMap: {
                [testAccountId]: testUserId1,
                [testAccountId2]: testUserId2
            }
        };

        const retrieveAccountsQuery = `select boost_id, account_id, owner_user_id from ${boostUserTable} inner join ` + 
            `${accountTable} on ${boostUserTable}.account_id = ${accountTable}.account_id where boost_id in ($1) and status in ($2)`;

        const testInput = { boostId: [testBoostId], status: ['PENDING'] };

        const mockPersistenceReturn = [testAccountId, testAccountId2].map((accountId, index) => accountUserIdRow(accountId, testUserIds[index]));
        queryStub.withArgs(retrieveAccountsQuery, [testBoostId, 'PENDING']).resolves(mockPersistenceReturn);

        const findUserAccountMap = await rds.findAccountsForBoost(testInput);
        expect(findUserAccountMap).to.exist;
        expect(findUserAccountMap).to.deep.equal(expectedResult);
    });

    // todo: throw an error if the account ID to which to limit does not exist
    it('Finds account ID and user ID correctly for a boost, limited', async () => {
        const testUserId = uuid();
        const expectedResult = {
            boostId: testBoostId,
            accountUserMap: {
                [testAccountId]: testUserId
            }
        };
        
        const retrieveAccountsQuery = `select boost_id, account_id, owner_user_id from ${boostUserTable} inner join ` +
            `${accountTable} on ${boostUserTable}.account_id = ${accountTable}.account_id where boost_id in ($1) and account_id in ($2)`;
        
        const testInput = { boostId: [testBoostId], accountId: [testAccountId] };

        const mockPersistenceReturn = accountUserIdRow(testAccountId, testUserId);
        queryStub.withArgs(retrieveAccountsQuery, [testBoostId, testAccountId]).resolves(mockPersistenceReturn);

        const findUserAccountMap = await rds.findAccountsForBoost(testInput);
        expect(findUserAccountMap).to.exist;
        expect(findUserAccountMap).to.deep.equal(expectedResult);
    });

    it('Updates boosts, including multiple accounts at a time, and also updates the status', async () => {
        const testAccountId2 = uuid();
        const testLogContext = { newStatus: 'REDEEMED', transactionId: uuid() };

        const mockUpdatedTime = moment();
        const secondTime = moment().add(1, 'second');
        const expectedResult = [{ boostId: testBoostId, updatedTime: mockUpdatedTime }];
        
        const updateAccount1 = updateAccountStatusDef(testBoostId, testAccountId, 'updated_time');
        const updateAccount2 = updateAccountStatusDef(testBoostId, testAccountId2, 'updated_time');

        const updateBoost = { table: boostTable, key: { boostId: testBoostId }, value: { active: false }, returnClause: 'updated_time' };
        
        // also log the boost being deactivated
        const logRowStatus = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId, logContext: testLogContext };
        const logRowStatus2 = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId2, logContext: testLogContext };
        const logRowBoost = { boostId: testBoostId, logType: 'BOOST_DEACTIVATED', accountId: null, logContext: testLogContext };

        const logInsertDef = assembleLogInsertDef([logRowStatus, logRowStatus2, logRowBoost]);

        const testInput = {
            boostId: testBoostId,
            accountId: [testAccountId, testAccountId2],
            newStatus: 'REDEEMED',
            stillActive: false,
            logType: 'USER_STATUS_CHANGE',
            logContext: testLogContext
        };

        // format is : list of query def responses, each such response being a list of rows with return values
        const mockResponseFromPersistence = [
            [{ 'updated_time': secondTime.format()}], [{ 'updated_time': moment().format() }], [{ 'updated_time': mockUpdatedTime.format() }],
            [{ 'creation_time': moment().format() }]
        ];
        multiOpStub.withArgs([updateAccount1, updateAccount2, updateBoost], [logInsertDef]).resolves(mockResponseFromPersistence);

        const updateBoostResult = await rds.updateBoostResult([testInput]);
        expect(updateBoostResult).to.exist;
        expect(updateBoost).to.deep.equal(expectedResult);
    });

    it('Updates boosts, just one account update', async () => {
        const updateAccount = updateAccountStatusDef(testBoostId, testAccountId, 'updated_time');
        const mockUpdatedTime = moment();
        const expectedResult = [{ boostId: testBoostId, updatedTime: mockUpdatedTime }];
        
        const logRowStatus = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId, logContext: testLogContext };
        const logInsertDef = assembleLogInsertDef([logRowStatus]);

        const testInput = {
            boostId: testBoostId,
            accountId: [testAccountId],
            newStatus: 'REDEEMED',
            logType: 'USER_STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', transactionId: uuid() }
        };

        // format is : list of query def responses, each such response being a list of rows with return values
        const mockResponseFromPersistence = [
            [{ 'updated_time': mockUpdatedTime.format()}], [{ 'creation_time': moment().format() }]
        ];
        multiOpStub.withArgs([updateAccount], [logInsertDef]).resolves(mockResponseFromPersistence);

        const updateBoostResult = await rds.updateBoostResult([testInput]);
        expect(updateBoostResult).to.exist;
        expect(updateBoostResult).to.deep.equal(expectedResult);
    });

});