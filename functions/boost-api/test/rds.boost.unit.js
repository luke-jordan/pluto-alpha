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
chai.use(require('chai-as-promised'));

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

const resetStubs = () => testHelper.resetStubs(queryStub, insertStub, multiTableStub, multiOpStub, uuidStub);
const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

const accountTable = config.get('tables.accountLedger');
const boostTable = config.get('tables.boostTable');
const boostUserTable = config.get('tables.boostAccountJoinTable');
const boostLogTable = config.get('tables.boostLogTable');

describe('*** UNIT TEST BOOSTS RDS *** Inserting boost instruction and boost-user records', () => {

    const testBoostId = uuid();
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
            { boostId: testBoostId, accountId: testEligibleAccountId, boostStatus: 'CREATED' },
            { boostId: testBoostId, accountId: testSecondAccountId, boostStatus: 'CREATED' }
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

});

describe('*** UNIT TEST BOOSTS RDS *** Unit test recording boost-user responses / logs', () => {

    const testAccountId = uuid();
    const testBoostId = uuid();
    const testInstructionId = uuid();
    const testAudienceId = uuid();

    const testStartTime = moment();
    const testEndTime = moment().add(1, 'week');

    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    // const testRedemptionMsgs = [{ accountId: uuid(), msgInstructionId: uuid() }, { accountId: uuid(), msgInstructionId: uuid() }];

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
        'boost_audience_type': 'INDIVIDUAL',
        'audience_id': testAudienceId,
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
        boostAudienceType: 'INDIVIDUAL',
        audienceId: testAudienceId,
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

    const accountUserIdRow = (accountId, userId, status = 'PENDING', boostId = testBoostId) => (
        { 'boost_id': boostId, 'account_id': accountId, 'owner_user_id': userId, 'boost_status': status }
    );

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


    it('Throws error if the account ID to which to limit does not exist', async () => {
        const expectedError = 'Account id not found';
        
        const retrieveAccountsQuery = `select boost_id, ${accountTable}.account_id, owner_user_id, boost_status from ` +
            `${boostUserTable} inner join ${accountTable} on ${boostUserTable}.account_id = ${accountTable}.account_id ` +
            `where boost_id in ($1) and ${accountTable}.account_id in ($2) order by boost_id, account_id`;
        
        const testInput = { boostIds: [testBoostId], accountIds: [testAccountId] };

        queryStub.withArgs(retrieveAccountsQuery, [testBoostId, testAccountId]).resolves([]);
        await expect(rds.findAccountsForBoost(testInput)).to.be.rejectedWith(expectedError);
        expect(queryStub).to.have.been.calledOnceWithExactly(retrieveAccountsQuery, [testBoostId, testAccountId]);
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
        const logRowBoost = { boostId: testBoostId, logType: 'BOOST_DEACTIVATED' };

        const logStatusDef = assembleLogInsertDef([logRowStatus, logRowStatus2], true);
        const logBoostDef = { 
            query: `insert into ${boostLogTable} (boost_id, log_type) values %L returning log_id, creation_time`,
            columnTemplate: '${boostId}, ${logType}',
            rows: [logRowBoost]
        };

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

    it('Updates multiple boosts at a time, handles errors', async () => {
        const testAccountId2 = uuid();
        const testLogContext = { newStatus: 'REDEEMED', transactionId: uuid() };

        const mockUpdatedTime = moment().add(1, 'second');
        const secondTime = moment();
        const expectedError = 'Query error';
        const expectedResult = [
            { boostId: testBoostId, updatedTime: moment(mockUpdatedTime.format()) },
            { boostId: testBoostId, error: expectedError },
            { boostId: testBoostId, updatedTime: moment(mockUpdatedTime.format()) }
        ];
        
        const updateAccount1 = updateAccountStatusDef(testBoostId, testAccountId, 'REDEEMED');
        const updateAccount2 = updateAccountStatusDef(testBoostId, testAccountId2, 'REDEEMED');

        const updateBoost = { table: boostTable, key: { boostId: testBoostId }, value: { active: false }, returnClause: 'updated_time' };
        
        // also log the boost being deactivated
        const logRowStatus = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId, logContext: testLogContext };
        const logRowStatus2 = { boostId: testBoostId, logType: 'USER_STATUS_CHANGE', accountId: testAccountId2, logContext: testLogContext };
        const logRowBoost = { boostId: testBoostId, logType: 'BOOST_DEACTIVATED' };

        const logStatusDef = assembleLogInsertDef([logRowStatus, logRowStatus2], true);
        const logBoostDef = { 
            query: `insert into ${boostLogTable} (boost_id, log_type) values %L returning log_id, creation_time`,
            columnTemplate: '${boostId}, ${logType}',
            rows: [logRowBoost]
        };

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
        multiOpStub.onFirstCall().resolves(mockResponseFromPersistence);
        multiOpStub.onSecondCall().throws(new Error(expectedError));
        multiOpStub.onThirdCall().resolves(mockResponseFromPersistence);

        const updateBoostResult = await rds.updateBoostAccountStatus([testInput, testInput, testInput]);
    
        expect(updateBoostResult).to.exist;
        expect(updateBoostResult).to.deep.equal(expectedResult);
        expect(multiOpStub).to.have.been.calledThrice;
        expect(multiOpStub).to.have.been.calledWith([updateAccount1, updateAccount2, updateBoost], [logStatusDef, logBoostDef]);
    });

    // note: although top-level arrays are part of JSON spec, somewhere between Postgres and Node-PG they tend to get
    // unreliable and throw errors, so wrapping them in case 
    it('Alters boosts and records logs', async () => {
        const testMsgInstructId = uuid();
        const mockUpdatedTime = moment();

        const messageDefs = [{ accountId: 'ALL', status: 'ALL', msgInstructionId: testMsgInstructId }];
        const alterBoostValue = { 
            messageInstructionIds: {
                instructions: messageDefs
            }
        };

        const expectedUpdateDef = {
            table: boostTable,
            key: { boostId: testBoostId },
            value: alterBoostValue,
            returnClause: 'updated_time'
        };
        const expectedLogDef = assembleLogInsertDef([{ boostId: testBoostId, logType: 'BOOST_ALTERED', logContext: { value: alterBoostValue }}]);

        const mockResponseFromPersistence = [
            [{ 'updated_time': mockUpdatedTime.format()}], [{ 'creation_time': moment().format() }]
        ];

        multiOpStub.resolves(mockResponseFromPersistence);

        const alterBoostResult = await rds.setBoostMessages(testBoostId, messageDefs);
        expect(alterBoostResult).to.exist;
        expect(alterBoostResult).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        const passedUpdateDef = multiOpStub.getCall(0).args[0][0];
        expect(passedUpdateDef).to.deep.equal(expectedUpdateDef);
        
        const passedLogDeg = multiOpStub.getCall(0).args[1][0];
        expect(passedLogDeg).to.deep.equal(expectedLogDef); 

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

    it('Returns null where no instruction matches flag', async () => {
        const expectedQuery = `select instruction_id from ${config.get('tables.msgInstructionTable')} where flags && ARRAY[$1] order by creation_time desc limit 1`;
        queryStub.withArgs(expectedQuery, ['TEST_FLAG']).resolves([]);

        const result = await rds.findMsgInstructionByFlag('TEST_FLAG');
        logger('Result of instruction extraction by flag:', result);

        expect(result).to.be.null;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['TEST_FLAG']);
    });

});
