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

const proxyquire = require('proxyquire').noCallThru();

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
const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

const accountTable = config.get('tables.accountLedger');
const boostTable = config.get('tables.boostTable');
const boostUserTable = config.get('tables.boostAccountJoinTable');
const boostLogTable = config.get('tables.boostLogTable');

describe('*** UNIT TEST BOOSTS RDS *** Inserting boost instruction and boost-user records', () => {

    const testBoostId = uuid();
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testRedemptionMsgs = [{ accountId: 'ALL', msgInstructionId: uuid() }];

    const audienceQueryBase = `select account_id from ${accountTable}`;
    const standardBoostKeys = ['boostId', 'creatingUserId', 'startTime', 'endTime', 'boostType', 'boostCategory', 'boostAmount', 
        'boostUnit', 'boostCurrency', 'fromBonusPoolId', 'fromFloatId', 'forClientId', 'boostAudience', 'audienceSelection', 
        'statusConditions', 'messageInstructionIds', 'conditionValues', 'flags'];
    const boostUserKeys = ['boostId', 'accountId', 'boostStatus'];
    
    beforeEach(() => (resetStubs()));

    // todo : also add the logs
    it('Insert a referral code and construct the two entry logs', async () => {

        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testInstructionId = uuid();
        const testCreatingUserId = uuid();
        const testReferringAccountId = uuid();
        const testReferredUserAccountId = uuid();
        const relevantUsers = [testReferringAccountId, testReferredUserAccountId];


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
            creatingUserId: testCreatingUserId,
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_float',
            forClientId: 'some_client_co',
            boostAudience: 'INDIVIDUAL',
            audienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
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
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            statusConditions: testStatusCondition,
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
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

        expect(multiTableStub).to.have.been.calledOnce;
        const multiTableArgs = multiTableStub.getCall(0).args[0];
        expect(multiTableArgs[1]).to.deep.equal(expectedSecondDef);
        expect(multiTableArgs[0]).to.deep.equal(insertFirstDef);
    });

});

describe('*** UNIT TEST BOOSTS RDS *** Unit test recording boost-user responses / logs', () => {

    const testAccountId = uuid();
    const testBoostId = uuid();
    const testInstructionId = uuid();


    const testStartTime = moment();
    const testEndTime = moment().add(1, 'week');

    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testAudienceSelection = `whole_universe from #{'{"specific_users": ["${uuid()}","${uuid()}"]}'}`;
    const testRedemptionMsgs = [{ accountId: uuid(), msgInstructionId: uuid() }, { accountId: uuid(), msgInstructionId: uuid() }];

    const updateAccountStatusDef = (boostId, accountId, newStatus) => ({
        table: boostUserTable,
        key: { boostId, accountId },
        value: { boostStatus: newStatus },
        returnClause: 'updated_time'
    });

    const logColumnsWithAccount = ['boostId', 'accountId', 'logType', 'logContext'];
    const logColumnsWithoutAccount = ['boostId', 'logType', 'logContext'];
    const assembleLogInsertDef = (logRows, haveAccountId = false) => {
        const columns = haveAccountId ? logColumnsWithAccount : logColumnsWithoutAccount;
        return {
            query: `insert into ${boostLogTable} (${extractQueryClause(columns)}) values %L returning log_id, creation_time`,
            columnTemplate: extractColumnTemplate(columns),
            rows: logRows
        };
    };

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
        'status_conditions': testStatusCondition,
        'boost_audience': 'INDIVIDUAL',
        'audience_selection': testAudienceSelection,
        'message_instruction_ids': { instructions: [testInstructionId, testInstructionId] },
        'initial_status': 'PENDING',
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
        boostStartTime: moment(testStartTime.format()),
        boostEndTime: moment(testEndTime.format()),
        statusConditions: testStatusCondition,
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection: testAudienceSelection,
        defaultStatus: 'PENDING',
        messageInstructions: [testInstructionId, testInstructionId],
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
        newBoost.boostStartTime = moment(testStartTime.format());
        newBoost.boostEndTime = moment(testEndTime.format());
        return newBoost;
    };

    const accountUserIdRow = (accountId, userId, status = 'PENDING', boostId = testBoostId) => 
        ({ 'boost_id': boostId, 'account_id': accountId, 'owner_user_id': userId, 'boost_status': status });

    beforeEach(() => resetStubs());

    it('Finds one active boost correctly, assembling query as needed, including current status', async () => {
        const expectedFindBoostQuery = `select distinct(boost_id) from ${boostUserTable} where account_id in ($1) and boost_status in ($2, $3)`;
        const retrieveBoostDetailsQuery = `select * from ${boostTable} where boost_id in ($1) and active = true`;

        const testInput = {
            accountId: [testAccountId], boostStatus: ['OFFERED', 'PENDING'], active: true
        };

        queryStub.withArgs(expectedFindBoostQuery, [testAccountId, 'OFFERED', 'PENDING']).resolves([{ 'boost_id': testBoostId }]);
        queryStub.withArgs(retrieveBoostDetailsQuery, [testBoostId]).resolves([boostFromPersistence]);

        const findBoostResponse = await rds.findBoost(testInput);
        logger('Result of active boost extraction:', findBoostResponse);
        
        expect(findBoostResponse).to.exist;
        expect(findBoostResponse).to.deep.equal([expectedBoostResult]);


    });

    it('Finds multiple active boosts correctly', async () => {
        const testAccountIds = [uuid(), uuid()];
        const testBoostIds = [uuid(), uuid(), uuid()];

        const boostIdsFromPersistence = testBoostIds.map((boostId) => ({ 'boost_id': boostId }));
        const testBoostsFromPersistence = testBoostIds.map(generateSimpleBoostFromPersistence);
        
        const expectedFindBoostQuery = `select distinct(boost_id) from ${boostUserTable} where account_id in ($1, $2) and boost_status in ($3)`;
        const retrieveBoostDetailsQuery = `select * from ${boostTable} where boost_id in ($1, $2, $3)`;

        const testInput = { accountId: testAccountIds, boostStatus: ['OFFERED'] };
        const expectedResult = testBoostIds.map(generateSimpleExpectedBoost);

        queryStub.withArgs(expectedFindBoostQuery, sinon.match([testAccountIds[0], testAccountIds[1], 'OFFERED'])).resolves(boostIdsFromPersistence);
        queryStub.withArgs(retrieveBoostDetailsQuery, testBoostIds).resolves(testBoostsFromPersistence);

        const findBoostResponse = await rds.findBoost(testInput);
        expect(findBoostResponse).to.exist;
        expect(findBoostResponse).to.be.an('array').of.length(3);
        // testHelper.logNestedMatches(expectedResult[0], findBoostResponse[0]);
        expect(sinon.match(expectedResult).test(findBoostResponse)).to.be.true;
    });

    // boosts only ever affect (1) all related accounts of a certain current status in relation to that boost, or (2) a specific account
    it('Finds account IDs and user IDs correctly for a boost, find all pending', async () => {
        const testAccountId2 = uuid();
        const testUserIds = [uuid(), uuid()];
        const [testUserId1, testUserId2] = testUserIds;
        const expectedResult = [{
            boostId: testBoostId,
            accountUserMap: {
                [testAccountId]: { userId: testUserId1, status: 'PENDING' },
                [testAccountId2]: { userId: testUserId2, status: 'PENDING' }
            }
        }];

        const retrieveAccountsQuery = `select boost_id, ${accountTable}.account_id, owner_user_id, boost_status from ` +
            `${boostUserTable} inner join ${accountTable} on ${boostUserTable}.account_id = ${accountTable}.account_id ` +
            `where boost_id in ($1) and boost_status in ($2) order by boost_id, account_id`;

        const testInput = { boostIds: [testBoostId], status: ['PENDING'] };

        const mockPersistenceReturn = [testAccountId, testAccountId2].map((accountId, index) => accountUserIdRow(accountId, testUserIds[index], 'PENDING'));
        queryStub.withArgs(retrieveAccountsQuery, [testBoostId, 'PENDING']).resolves(mockPersistenceReturn);

        const findUserAccountMap = await rds.findAccountsForBoost(testInput);
        expect(findUserAccountMap).to.exist;
        expect(findUserAccountMap).to.deep.equal(expectedResult);
    });

    // todo: throw an error if the account ID to which to limit does not exist
    it('Finds account ID and user ID correctly for a boost, limited', async () => {
        const testUserId = uuid();
        const expectedResult = [{
            boostId: testBoostId,
            accountUserMap: {
                [testAccountId]: {
                    userId: testUserId,
                    status: 'PENDING'
                }
            }
        }];
        
        const retrieveAccountsQuery = `select boost_id, ${accountTable}.account_id, owner_user_id, boost_status from ` +
            `${boostUserTable} inner join ${accountTable} on ${boostUserTable}.account_id = ${accountTable}.account_id ` +
            `where boost_id in ($1) and ${accountTable}.account_id in ($2) order by boost_id, account_id`;
        
        const testInput = { boostIds: [testBoostId], accountIds: [testAccountId] };

        const mockPersistenceReturn = [accountUserIdRow(testAccountId, testUserId)];
        queryStub.withArgs(retrieveAccountsQuery, [testBoostId, testAccountId]).resolves(mockPersistenceReturn);

        const findUserAccountMap = await rds.findAccountsForBoost(testInput);
        logger('Resulting map: ', findUserAccountMap);

        expect(findUserAccountMap).to.exist;
        expect(findUserAccountMap).to.deep.equal(expectedResult);
    });

    it('Updates boosts, including multiple accounts at a time, and also updates the status', async () => {
        const testAccountId2 = uuid();
        const testLogContext = { newStatus: 'REDEEMED', transactionId: uuid() };

        const mockUpdatedTime = moment().add(1, 'second');
        const secondTime = moment();
        const expectedResult = [{ boostId: testBoostId, updatedTime: moment(mockUpdatedTime.format()) }];
        
        const updateAccount1 = updateAccountStatusDef(testBoostId, testAccountId, 'REDEEMED');
        const updateAccount2 = updateAccountStatusDef(testBoostId, testAccountId2, 'REDEEMED');

        const updateBoost = { table: boostTable, key: { boostId: testBoostId }, value: { active: false }, returnClause: 'updated_time' };
        
        // also log the boost being deactivated
        const logRowStatus = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId, logContext: testLogContext };
        const logRowStatus2 = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId2, logContext: testLogContext };
        const logRowBoost = { boostId: testBoostId, logType: 'BOOST_DEACTIVATED', logContext: testLogContext };

        const logStatusDef = assembleLogInsertDef([logRowStatus, logRowStatus2], true);
        const logBoostDef = assembleLogInsertDef([logRowBoost], false);

        const testInput = {
            boostId: testBoostId,
            accountIds: [testAccountId, testAccountId2],
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
        multiOpStub.resolves(mockResponseFromPersistence);

        const updateBoostResult = await rds.updateBoostAccountStatus([testInput]);
    
        expect(updateBoostResult).to.exist;
        expect(updateBoostResult).to.deep.equal(expectedResult);
        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub).to.have.been.calledWith([updateAccount1, updateAccount2, updateBoost], [logStatusDef, logBoostDef]);
    });

    it('Updates boosts, just one account update', async () => {
        const updateAccount = updateAccountStatusDef(testBoostId, testAccountId, 'REDEEMED');
        const mockUpdatedTime = moment();
        const testLogContext = { newStatus: 'REDEEMED', transactionId: uuid() };

        const expectedResult = [{ boostId: testBoostId, updatedTime: moment(mockUpdatedTime.format()) }];
        
        const logRowStatus = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId, logContext: testLogContext };
        const logInsertDef = assembleLogInsertDef([logRowStatus], true);

        const testInput = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            logType: 'USER_STATUS_CHANGE',
            logContext: testLogContext
        };

        // format is : list of query def responses, each such response being a list of rows with return values
        const mockResponseFromPersistence = [
            [{ 'updated_time': mockUpdatedTime.format()}], [{ 'creation_time': moment().format() }]
        ];
        multiOpStub.withArgs([updateAccount], [logInsertDef]).resolves(mockResponseFromPersistence);

        const updateBoostResult = await rds.updateBoostAccountStatus([testInput]);
        
        expect(updateBoostResult).to.exist;
        expect(updateBoostResult).to.deep.equal(expectedResult);
    });

    // note: although top-level arrays are part of JSON spec, somewhere between Postgres and Node-PG they tend to get
    // unreliable and throw errors, so wrapping them in case 
    it('Alters boosts and records logs', async () => {
        const testMsgInstructId = uuid();
        const mockUpdatedTime = moment();

        const alterBoostValue = { 
            messageInstructionIds: {
                instructions: [{ accountId: 'ALL', status: 'ALL', msgInstructionId: testMsgInstructId }]
            }
        };

        const expectedUpdateDef = {
            table: boostTable,
            key: { boostId: testBoostId },
            value: alterBoostValue,
            returnClause: 'updated_time'
        };
        const expectedLogDef = assembleLogInsertDef([{ boostId: testBoostId, logType: 'BOOST_ALTERED', logContext: alterBoostValue }]);

        const mockResponseFromPersistence = [
            [{ 'updated_time': mockUpdatedTime.format()}], [{ 'creation_time': moment().format() }]
        ];

        multiOpStub.resolves(mockResponseFromPersistence);

        const alterBoostResult = await rds.alterBoost(testBoostId, alterBoostValue);
        expect(alterBoostResult).to.exist;
        expect(alterBoostResult).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(multiOpStub).to.have.been.calledOnceWithExactly([expectedUpdateDef], [expectedLogDef]);
    });

    it('Finds message instructions by flag', async () => {
        const expectedQuery = `select instruction_id from ${config.get('tables.msgInstructionTable')} where flags && ARRAY[$1] order by creation_time desc limit 1`;
        queryStub.withArgs(expectedQuery, ['TEST_FLAG']).resolves([{ 'instruction_id': testInstructionId }]);

        const result = await rds.findMsgInstructionByFlag('TEST_FLAG');
        logger('Result of instruction extraction by flag:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(testInstructionId);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['TEST_FLAG']);
    });

    it('Returns undefined where no instruction matches flag', async () => {
        const expectedQuery = `select instruction_id from ${config.get('tables.msgInstructionTable')} where flags && ARRAY[$1] order by creation_time desc limit 1`;
        queryStub.withArgs(expectedQuery, ['TEST_FLAG']).resolves([]);

        const result = await rds.findMsgInstructionByFlag('TEST_FLAG');
        logger('Result of instruction extraction by flag:', result);

        expect(result).to.be.undefined;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['TEST_FLAG']);
    });

});