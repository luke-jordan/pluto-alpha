'use strict';

const uuid = require('uuid/v4');
const moment = require('moment');

const helper = require('./test-helper');
const util = require('ops-util-common');

const camelcaseKeys = require('camelcase-keys');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const { expect } = chai;

const proxyquire = require('proxyquire').noCallThru();

const simpleInsertStub = sinon.stub();
const plainUpdateStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();

const queryStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.updateRecord = plainUpdateStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const persistenceWrite = proxyquire('../persistence/write.friends.pools', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub
});

const persistenceRead = proxyquire('../persistence/read.friends', {
    'rds-common': MockRdsConnection,
    // eslint-disable-next-line
    'ioredis': class { constructor() { } }
});

const testUserId = uuid();

describe('*** UNIT TEST FRIEND SAVING PERSISTENCE, WRITES ***', async () => {

    const testPoolId = uuid();

    const relationshipUserPair = (relationshipId, userId) => ({ relationshipId, userId });
    const mockRelUser = (number) => relationshipUserPair(`relationship-${number}`, `user-${number}`);

    beforeEach(() => helper.resetStubs(simpleInsertStub, multiTableStub, multiOpStub, queryStub, uuidStub));

    it('Creates a new saving pot', async () => {
        const testPersistedMoment = moment();

        const testInput = {
            poolName: 'Trip to Japan',
            creatingUserId: testUserId,
            targetAmount: 10000,
            targetUnit: 'WHOLE_CURRENCY',
            targetCurrency: 'EUR',
            participatingUsers: [mockRelUser(1), mockRelUser(2), mockRelUser(3)]
        };

        uuidStub.onFirstCall().returns(testPoolId);

        const expectedObject = {
            savingPoolId: testPoolId,
            creatingUserId: testUserId,
            targetAmount: 10000 * 10000,
            targetUnit: 'HUNDREDTH_CENT',
            targetCurrency: 'EUR',
            poolName: 'Trip to Japan'
        };

        const poolColumns = ['saving_pool_id', 'creating_user_id', 'target_amount', 'target_unit', 'target_currency', 'pool_name'];
        const primaryInputDef = {
            query: `insert into friend_data.saving_pool (${poolColumns.join(', ')}) values %L returning creation_time`,
            columnTemplate: util.extractColumnTemplate(Object.keys(expectedObject)),
            rows: [expectedObject]
        };

        // very very likely this will evolve into an entity, so giving it a pkey (auto-gen uuid would be nice right now, but)
        const mockJoinerPartId = uuid();
        uuidStub.onSecondCall().returns(mockJoinerPartId);
        const joinCreatorDef = {
            query: `insert into friend_data.saving_pool_participant (participation_id, saving_pool_id, user_id) values %L`,
            columnTemplate: '${participationId}, ${savingPoolId}, ${creatingUserId}',
            rows: [{ participationId: mockJoinerPartId, savingPoolId: testPoolId, creatingUserId: testUserId }]
        };

        const mockPartIds = [];
        testInput.participatingUsers.forEach((_, index) => {
            const mockId = uuid();
            mockPartIds.push(mockId);
            uuidStub.onCall(index + 3).returns(mockId);
        });

        const joinParticipantsDef = {
            query: `insert into friend_data.saving_pool_participant (participation_id, saving_pool_id, user_id, relationship_id) values %L returning creation_time`,
            columnTemplate: '${participationId}, ${savingPoolId}, ${userId}, ${relationshipId}',
            rows: testInput.participatingUsers.map(({ userId, relationshipId }, index) => (
                { participationId: mockPartIds[index], savingPoolId: testPoolId, userId, relationshipId })
            )
        };

        const poolCreateLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relevant_user_id) values %L`,
            columnTemplate: '${logId}, *{SAVING_POOL_CREATED}, ${savingPoolId}, ${creatingUserId}',
            rows: [{ logId: 'ugh', savingPoolId: testPoolId, creatingUserId: testUserId }]
        };

        const expectedLogRows = testInput.participatingUsers.map(({ userId, relationshipId }) => ({ logId: uuid(), relationshipId, savingPoolId: testPoolId, userId }));
        const poolJoinLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id) values %L`,
            columnTemplate: '${logId}, *{FRIEND_ADDED_TO_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}',
            rows: expectedLogRows
        };

        multiTableStub.resolves([
            [{ 'creation_time': testPersistedMoment.format() }],
            [], // no return clause for creating user participation, not needed
            [], // similarly, not needed for other user joins
            [], // or for create log
            [] // or for join logs
        ]);

        const resultOfPersistence = await persistenceWrite.persistNewSavingPool(testInput);
        expect(resultOfPersistence).to.deep.equal({ savingPoolId: testPoolId, persistedTime: moment(testPersistedMoment.format()) });

        expect(multiTableStub).to.have.been.calledOnce;
        const insertArgs = multiTableStub.getCall(0).args;
        expect(insertArgs).to.have.length(1);

        const insertDefs = insertArgs[0];
        expect(insertDefs).to.have.length(5);
        expect(insertDefs[0]).to.deep.equal(primaryInputDef);
        expect(insertDefs[1]).to.deep.equal(joinCreatorDef);
        helper.matchWithoutLogId(insertDefs[2], poolCreateLogDef);
        expect(insertDefs[3]).to.deep.equal(joinParticipantsDef);
        helper.matchWithoutLogId(insertDefs[4], poolJoinLogDef);
    });

    it('Updates a saving pot name', async () => {
        const mockUpdatedTime = moment();
        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            poolName: 'Trip to Taipei'
        };

        // to store old values
        const expectedFetchQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';
        queryStub.resolves([{ 'pool_name': 'Trip to Japan', 'creating_user_id': testUserId }]);

        const expectedUpdateDef = {
            table: 'friend_data.saving_pool',
            key: { savingPoolId: testPoolId },
            value: { poolName: 'Trip to Taipei' },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: uuid(),
            savingPoolId: testPoolId,
            userId: testUserId,
            logContext: { changeFields: [{ fieldName: 'poolName', oldValue: 'Trip to Japan', newValue: 'Trip to Taipei' }] }
        };

        const expectedLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relevant_user_id, log_context) values %L`,
            columnTemplate: '${logId}, *{SAVING_POOL_UPDATE}, ${savingPoolId}, ${updatingUserId}, ${logContext}',
            rows: [logObject]
        };

        multiOpStub.resolves([
            [{ 'updated_time': mockUpdatedTime.format() }],
            [] // dont need log return
        ]);

        const resultOfUpdate = await persistenceWrite.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedFetchQuery, [testPoolId]);
        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub.getCall(0).args[0]).to.deep.equal([expectedUpdateDef]);
        helper.matchWithoutLogId(multiOpStub.getCall(0).args[1][0], expectedLogDef);
    });

    it('Adds someone to a saving pot, normal happy path', async () => {
        const mockUpdatedTime = moment();
        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockRelUser(10)]
        };

        // first call is existence of pool & user rights
        queryStub.onFirstCall().resolves([{ 'creating_user_id': testUserId }]);

        const checkExistenceQuery = 'select participation_id, relationship_id, user_id, active from friend_data.saving_pool_participant ' +
            'where saving_pool_id = $1 and user_id in ($2)';
        queryStub.onSecondCall().resolves([]);

        const mockParticipationId = uuid();
        uuidStub.onFirstCall().returns(mockParticipationId);
        const joinParticipantsDef = {
            query: `insert into friend_data.saving_pool_participant (participation_id, saving_pool_id, user_id, relationship_id) values %L returning creation_time`,
            columnTemplate: '${participationId}, ${savingPoolId}, ${userId}, ${relationshipId}',
            rows: [{ participationId: mockParticipationId, savingPoolId: testPoolId, userId: 'user-10', relationshipId: 'relationship-10' }]
        };

        const mockLogId = uuid();
        uuidStub.onSecondCall().returns(mockLogId);
        const logObject = {
            logId: mockLogId,
            savingPoolId: testPoolId,
            relationshipId: 'relationship-10',
            userId: 'user-10'
        };

        const poolJoinLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id) values %L`,
            columnTemplate: '${logId}, *{FRIEND_ADDED_TO_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}',
            rows: [logObject]
        };

        multiTableStub.resolves([
            [{ 'creation_time': mockUpdatedTime.format() }],
            []
        ]);

        const resultOfUpdate = await persistenceWrite.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(queryStub).to.have.been.calledTwice; // first call for existing values covered above
        expect(queryStub).to.have.been.calledWithExactly(checkExistenceQuery, [testPoolId, 'user-10']);

        expect(multiTableStub).to.have.been.calledOnce;
        expect(multiTableStub.getCall(0).args[0][0]).to.deep.equal(joinParticipantsDef);
        helper.matchWithoutLogId(multiTableStub.getCall(0).args[0][1], poolJoinLogDef);
    });

    it('Does not add someone if they are already part and active', async () => {
        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockRelUser(10)]
        };

        queryStub.onFirstCall().resolves([{ 'creating_user_id': testUserId }]); // for user rights check

        const checkExistenceQuery = 'select participation_id, relationship_id, user_id, active from friend_data.saving_pool_participant ' +
            'where saving_pool_id = $1 and user_id in ($2)';
        queryStub.onSecondCall().resolves([{ 'active': true, 'user_id': 'user-10' }]);

        await expect(persistenceWrite.updateSavingPool(testInput)).to.eventually.be.rejectedWith('Error, nothing to do!');

        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(checkExistenceQuery, [testPoolId, 'user-10']);
        expect(multiTableStub).to.not.have.been.called;
        expect(multiOpStub).to.not.have.been.called;
    });

    it('Flips someone to active if re-added', async () => {
        const mockParticipationId = uuid();
        const mockUpdatedTime = moment();

        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockRelUser(10)]
        };

        const updateParticipantDef = {
            table: 'friend_data.saving_pool_participant',
            key: { participationId: mockParticipationId },
            value: { active: true },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: 'ugh',
            savingPoolId: testPoolId,
            relationshipId: 'relationship-10',
            userId: 'user-10',
            logContext: { reactivation: true }
        };

        const insertLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id, log_context) values %L`,
            columnTemplate: '${logId}, *{FRIEND_READDED_TO_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}, ${logContext}',
            rows: [logObject]
        };

        queryStub.onFirstCall().resolves([{ 'creating_user_id': testUserId }]); // for user rights check
        queryStub.onSecondCall().resolves([{ 'participation_id': mockParticipationId, 'user_id': 'user-10', 'active': false, 'relationship_id': 'relationship-10' }]);

        multiOpStub.resolves([
            [{ 'updated_time': mockUpdatedTime.format() }],
            []
        ]);

        const resultOfUpdate = await persistenceWrite.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        // query stub covered amply above

        expect(multiTableStub).to.not.have.been.called;
        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub.getCall(0).args[0][0]).to.deep.equal(updateParticipantDef);
        helper.matchWithoutLogId(multiOpStub.getCall(0).args[1][0], insertLogDef);
    });

    it('Updates a saving pot target', async () => {
        const mockUpdatedTime = moment();

        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            targetAmount: 15000,
            targetUnit: 'WHOLE_CURRENCY',
            targetCurrency: 'EUR'
        };

        const expectedUpdateDef = {
            table: 'friend_data.saving_pool',
            key: { savingPoolId: testPoolId },
            value: { targetAmount: 15000 * 10000 },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: uuid(),
            savingPoolId: testPoolId,
            userId: testUserId,
            logContext: { changeFields: [{ fieldName: 'targetAmount', oldValue: 10000 * 10000, newValue: 15000 * 10000 }] }
        };

        const expectedLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relevant_user_id, log_context) values %L`,
            columnTemplate: '${logId}, *{SAVING_POOL_UPDATE}, ${savingPoolId}, ${updatingUserId}, ${logContext}',
            rows: [logObject]
        };

        queryStub.resolves([{ 'target_amount': 10000 * 10000, 'target_unit': 'HUNDREDTH_CENT', 'target_currency': 'EUR', 'creating_user_id': testUserId }]);
        multiOpStub.resolves([
            [{ 'updated_time': mockUpdatedTime.format() }],
            [] // dont need log return
        ]);

        const resultOfUpdate = await persistenceWrite.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub.getCall(0).args[0][0]).to.deep.equal(expectedUpdateDef);
        helper.matchWithoutLogId(multiOpStub.getCall(0).args[1][0], expectedLogDef);
    });

    it.only('Removes someone (flips them to inactive)', async () => {
        const mockParticipationId = uuid();
        const mockUpdatedTime = moment();

        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToRemove: [mockRelUser(1)]
        };

        const updateParticipantDef = {
            table: 'friend_data.saving_pool_participant',
            key: { participationId: mockParticipationId },
            value: { active: false },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: 'this-log',
            savingPoolId: testPoolId,
            relationshipId: 'relationship-1',
            userId: 'user-1',
            logContext: { deactivation: true }
        };

        const insertLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relationship_id, relevant_user_id, log_context) values %L`,
            columnTemplate: '${logId}, *{FRIEND_REMOVED_FROM_POOL}, ${savingPoolId}, ${relationshipId}, ${userId}, ${logContext}',
            rows: [logObject]
        };

        queryStub.onFirstCall().resolves([{ 'creating_user_id': testUserId }]); // for user rights check
        queryStub.onSecondCall().resolves([{ 'participation_id': mockParticipationId, 'user_id': 'user-10', 'active': true, 'relationship_id': 'relationship-10' }]);

        multiOpStub.resolves([
            [{ 'updated_time': mockUpdatedTime.format() }], []
        ]);

        const resultOfUpdate = await persistenceWrite.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        // query stub covered amply above
        expect(multiTableStub).to.not.have.been.called;
        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub.getCall(0).args[0][0]).to.deep.equal(updateParticipantDef);
        helper.matchWithoutLogId(multiOpStub.getCall(0).args[1][0], insertLogDef);
    });

    it.only('Deactivates a saving pot', async () => {
        // flip everyone to deactivated, and change the pot, but assume transactions are handled elsewhere
        // note : might at some point want to fetch currently active users and log for all of them, but overkill for now while pools are just a kind of high powered tag
        const deactivateFriendDef = {
            table: 'friend_data.saving_pool_participant',
            key: { savingPoolId: 'test-pool-id', active: true },
            value: { active: false }
        };

        const deactivatePoolDef = {
            table: 'friend_data.saving_pool',
            key: { savingPoolId: 'test-pool-id' },
            value: { active: false },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: uuid(),
            savingPoolId: 'test-pool-id',
            userId: 'this-user',
            logContext: { deactivated: true }
        };

        const expectedLogDef = {
            query: `insert into friend_data.friend_log (log_id, log_type, saving_pool_id, relevant_user_id, log_context) values %L`,
            columnTemplate: '${logId}, *{SAVING_POOL_DEACTIVATED}, ${savingPoolId}, ${updatingUserId}, ${logContext}',
            rows: [logObject]
        };

        const mockUpdatedTime = moment();
        multiOpStub.resolves([
            [], [{ 'updated_time': mockUpdatedTime.format() }], []
        ]);

        const testInput = {
            savingPoolId: 'test-pool-id',
            active: false,
        };

        const resultOfUpdate = await persistenceWrite.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        // query stub covered amply above
        expect(multiTableStub).to.not.have.been.called;
        expect(multiOpStub).to.have.been.calledOnce;
        
        const multiOpArgs = multiOpStub.getCall(0).args;
        expect(multiOpArgs[0][0]).to.deep.equal(deactivateFriendDef);
        expect(multiOpArgs[0][1]).to.deep.equal(deactivatePoolDef);
        helper.matchWithoutLogId(multiOpArgs[1][0], expectedLogDef);
    });

    it('Removes transactions from the pot', async () => {
        // this is too light an operation to add tx logs etc (and overall operation will have system-wide user logs published)
        const expectedQuery = `update transaction_data.core_transaction_ledger set tags = array_remove(tags, $1) where ` +
            `transaction_id in ($2, $3) returning updated_time`;
        const expectedValues = [`SAVING_POOL::test-pool-id`, 'tx-1', 'tx-2'];

        const mockUpdatedTimes = [moment(), moment()];
        plainUpdateStub.resolves({ rows: mockUpdatedTimes.map((time) => ({ 'updated_time': time.format() }))});

        const testOperation = await persistenceWrite.removeTransactionsFromPool('test-pool-id', ['tx-1', 'tx-2']);
        expect(testOperation).to.be.an('array').with.length(2);
        expect(testOperation[0].updatedTime.format()).to.equal(mockUpdatedTimes[0].format());

        expect(plainUpdateStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedValues);
    });

});

describe('**** UNIT TEST FRIEND SAVING PERSISTENCE, READS ***', async () => {

    const testPoolId = uuid();

    // if this starts to strain, we can either unnnest tags to select on & group by tag, but for each call, volumes should
    // easily be low enough to allow the in-memory summation to be fine, but keep an eye out
    const expectedTransactionQuery = `select transaction_id, settlement_time, amount, currency, unit, owner_user_id, ` +
        `transaction_data.core_transaction_ledger.tags from transaction_data.core_transaction_ledger inner join account_data.core_account_ledger ` +
        `on transaction_data.core_transaction_ledger.account_id = account_data.core_account_ledger.account_id ` +
        `where settlement_status = $1 and transaction_data.core_transaction_ledger.tags && $2`;

    const mockTransaction = (poolId, amount, unit = 'HUNDREDTH_CENT', txId = 'UGH') => ({ 'transaction_id': txId, 'amount': amount, unit, currency: 'EUR', tags: [`SAVING_POOL::${poolId}`] });

    beforeEach(() => helper.resetStubs(queryStub));

    it('Finds savings pots (basic details) that user is part of', async () => {
        const expectedQuery = 'select * from friend_data.saving_pool inner join friend_data.saving_pool_participant ' +
            `on friend_data.saving_pool.saving_pool_id = friend_data.saving_pool_participant.saving_pool_id ` +
            `where friend_data.saving_pool.active = true and friend_data.saving_pool_participant.active = true and ` +
            `friend_data.saving_pool_participant.user_id = $1`;

        const mockCreationTime1 = moment().subtract(1, 'weeks');
        const mockCreationTime2 = moment().subtract(2, 'weeks');

        const mockPoolsFromPersistence = [
            { 'saving_pool_id': 'pool-1', 'active': true, 'pool_name': 'First pool', 'creation_time': mockCreationTime1.format(), 'updated_time': mockCreationTime1.format() },
            { 'saving_pool_id': 'pool-2', 'active': true, 'pool_name': 'Second pool', 'creation_time': mockCreationTime2.format(), 'updated_time': mockCreationTime2.format() }
        ];

        queryStub.resolves(mockPoolsFromPersistence);

        const fetchResult = await persistenceRead.fetchSavingPoolsForUser(testUserId);

        const expectedPools = [
            { ...camelcaseKeys(mockPoolsFromPersistence[0]), creationTime: moment(mockCreationTime1.format()), updatedTime: moment(mockCreationTime1.format()) },
            { ...camelcaseKeys(mockPoolsFromPersistence[1]), creationTime: moment(mockCreationTime2.format()), updatedTime: moment(mockCreationTime2.format()) }
        ];

        expect(fetchResult).to.deep.equal(expectedPools);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, [testUserId]);
    });

    it('Calculates balance of set of savings pools', async () => {
        const mockPools = ['mock-pool-1', 'mock-pool-2', 'mock-pool-3'];

        const expectedTagArray = mockPools.map((poolId) => `SAVING_POOL::${poolId}`);

        const mockResultsFromPersistence = [
            mockTransaction('mock-pool-1', 20 * 10000),
            mockTransaction('mock-pool-1', 10, 'WHOLE_CURRENCY'),
            mockTransaction('mock-pool-2', 50 * 100, 'WHOLE_CENT')
        ];
        queryStub.resolves(mockResultsFromPersistence);

        const resultOfQuery = await persistenceRead.calculatePoolBalances(mockPools, 'EUR');

        const expectedResult = [
            { savingPoolId: 'mock-pool-1', amount: 30 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
            { savingPoolId: 'mock-pool-2', amount: 50 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
            { savingPoolId: 'mock-pool-3', amount: 0, unit: 'HUNDREDTH_CENT', currency: 'EUR' }
        ];

        expect(resultOfQuery).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedTransactionQuery, ['SETTLED', expectedTagArray]); // note [[]]
    });

    it('Gets basic details on a savings pool', async () => {
        const expectedQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';

        const mockCreationTime = moment().subtract(2, 'days');
        const mockUpdatedTime = moment().subtract(1, 'days');
        const mockPool = { 'saving_pool_id': testPoolId, 'creating_user_id': testUserId, 'active': true, 'pool_name': 'First pool', 'creation_time': mockCreationTime.format(), 'updated_time': mockUpdatedTime.format() };
        queryStub.withArgs(expectedQuery, [testPoolId]).resolves([mockPool]);

        const fetchResult = await persistenceRead.fetchSavingPoolDetails(testPoolId, false);
        expect(fetchResult).to.deep.equal({
            savingPoolId: testPoolId,
            creatingUserId: testUserId,
            active: true,
            poolName: 'First pool',
            creationTime: moment(mockCreationTime.format()),
            updatedTime: moment(mockUpdatedTime.format())
        });

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, [testPoolId]);
    });

    it('Gets history (all relevant info) on saving pot, including participants', async () => {
        const expectedFetchQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';
        const expectedParticipantQuery = 'select user_id, relationship_id, saving_pool_id from friend_data.saving_pool_participant ' +
            'where saving_pool_id in ($1) and active = true';
        const expectedContributionQuery = expectedTransactionQuery;

        const mockCreationTime = moment().subtract(1, 'week');
        const mockPool = { 
            'saving_pool_id': testPoolId, 
            'creating_user_id': testUserId, 
            'active': true, 
            'pool_name': 'First pool', 
            'creation_time': mockCreationTime.format(),
            'updated_time': mockCreationTime.format(),
            'target_amount': 50 * 10000,
            'target_unit': 'HUNDREDTH_CENT',
            'target_currency': 'EUR'
        };
        queryStub.withArgs(expectedFetchQuery, [testPoolId]).resolves([mockPool]);

        const mockParticipants = [{ 'user_id': testUserId }, { 'user_id': 'user-1', 'relationship_id': 'rel-1' }, { 'user_id': 'user-2', 'relationship_id': 'rel-2' }];
        queryStub.withArgs(expectedParticipantQuery, [testPoolId]).resolves(mockParticipants);

        const mockTxTimes = [moment().subtract(1, 'week'), moment().subtract(3, 'days')];
        const mockTransactions = [
            { ...mockTransaction(testPoolId, 10 * 10000, 'HUNDREDTH_CENT', 'tx1'), 'owner_user_id': testUserId, 'settlement_time': mockTxTimes[0].format() },
            { ...mockTransaction(testPoolId, 20 * 10000, 'HUNDREDTH_CENT', 'tx2'), 'owner_user_id': 'user-2', 'settlement_time': mockTxTimes[1].format() }
        ];
        queryStub.withArgs(expectedContributionQuery, ['SETTLED', [`SAVING_POOL::${testPoolId}`]]).resolves(mockTransactions);

        const fetchResult = await persistenceRead.fetchSavingPoolDetails(testPoolId, true);

        const expectedResult = {
            savingPoolId: testPoolId,
            creatingUserId: testUserId,
            active: true,
            poolName: 'First pool',

            creationTime: moment(mockCreationTime.format()),
            updatedTime: moment(mockCreationTime.format()),

            targetAmount: 50 * 10000,
            targetUnit: 'HUNDREDTH_CENT',
            targetCurrency: 'EUR',

            currentAmount: 30 * 10000,
            currentUnit: 'HUNDREDTH_CENT',
            currentCurrency: 'EUR',

            participatingUsers: [
                { userId: testUserId, relationshipId: 'CREATOR' },
                { userId: 'user-1', relationshipId: 'rel-1' },
                { userId: 'user-2', relationshipId: 'rel-2' }
            ],

            transactionRecord: [
                { transactionId: 'tx1', ownerUserId: testUserId, settlementTime: moment(mockTxTimes[0].format()), amount: 10 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
                { transactionId: 'tx2', ownerUserId: 'user-2', settlementTime: moment(mockTxTimes[1].format()), amount: 20 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' }
            ]
        };

        expect(fetchResult).to.deep.equal(expectedResult);

        expect(queryStub).to.have.been.calledWith(expectedFetchQuery, [testPoolId]);
        expect(queryStub).to.have.been.calledWith(expectedParticipantQuery, [testPoolId]);
        expect(queryStub).to.have.been.calledWith(expectedContributionQuery, ['SETTLED', [`SAVING_POOL::${testPoolId}`]]); // note [[]]
    });

    // useful aux method, first written for here
    it('Gets user IDs for set of friendships based on calling user id', async () => {
        const expectedFetchQuery = 'select initiated_user_id, accepted_user_id, relationship_id from ' +
            `friend_data.core_friend_relationship where relationship_status = $1 and (initiated_user_id = $2 or accepted_user_id = $2) ` +
            `and relationship_id in (${util.extractArrayIndices(['rel-1', 'rel-2', 'rel-3'], 3)})`;

        const mockRows = [
            { 'initiated_user_id': testUserId, 'accepted_user_id': 'user-1', 'relationship_id': 'rel-1' },
            { 'initiated_user_id': 'user-2', 'accepted_user_id': testUserId, 'relationship_id': 'rel-2' }
        ];

        queryStub.resolves(mockRows);

        const fetchResult = await persistenceRead.obtainFriendIds(testUserId, ['rel-1', 'rel-2', 'rel-3']);
        expect(fetchResult).to.deep.equal([{ userId: 'user-1', relationshipId: 'rel-1' }, { userId: 'user-2', relationshipId: 'rel-2' }]);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedFetchQuery, ['ACTIVE', testUserId, 'rel-1', 'rel-2', 'rel-3']);
    });

});
