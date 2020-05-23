'use strict';

const uuid = require('uuid/v4');

const helper = require('./test-helper');
const util = require('ops-util-common');

const camelcaseKeys = require('camelcase-keys');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const proxyquire = require('proxyquire').noCallThru();

const simpleInsertStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();

const queryStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor() {
        this.selectQuery = queryStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const persistenceWrite = proxyquire('../persistence/write.friends', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub 
});

const persistenceRead = proxyquire('../persistence/read.friends', {
    'rds-common': MockRdsConnection
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
            name: 'Trip to Japan',
            creatingUserId: testUserId,
            targetAmount: 10000,
            targetUnit: 'WHOLE_CURRENCY',
            targetCurrency: 'EUR',
            participatingUsers: [mockRelUser(1), mockRelUser(2), mockRelUser(3)]
        };

        const expectedObject = {
            savingPoolId: testPoolId,
            creatingUserId: testUserId,
            targetAmount: 10000 * 10000,
            targetUnit: 'HUNDREDTH_CENT',
            targetCurrency: 'EUR',
        };

        const poolColumns = ['saving_pool_id', 'creating_user_id', 'pool_name', 'target_amount', 'target_amount', 'target_unit', 'target_currency'];
        const primaryInputDef = {
            query: `insert into friend_data.saving_pool (${poolColumns.join(', ')}) values %L return creation_time`,
            columnTemplate: util.extractColumnTemplate(Object.keys(expectedObject)),
            rows: [expectedObject]
        };

        // very very likely this will evolve into an entity, so giving it a pkey (auto-gen uuid would be nice right now, but)
        const mockJoinerPartId = uuid();
        uuidStub.onFirstCall().returns(mockJoinerPartId);
        const joinCreatorDef = {
            query: `insert into friend_data.saving_pool_participant (participation_id, saving_pool_id, user_id) values %L`,
            columnTemplate: '${participationId}, ${poolId}, ${userId}',
            rows: [{ participationId: mockJoinerPartId, poolId: testPoolId, userId: testUserId }]
        };

        const mockPartIds = [];
        testInput.participatingUsers.forEach((_, index) => {
            const mockId = uuid();
            mockPartIds.push(mockId);
            uuidStub.onCall(index + 1).returns(mockId);
        });
        
        const joinParticipantsDef = {
            query: `insert into friend_data.saving_pool_participant (participation_id, saving_pool_id, user_id, relationship_id) values %L`,
            columnTemplate: '${participationId}, ${poolId}, ${userId}, ${relationshipId}',
            rows: testInput.participatingUsers.map(({ userId, relationshipId }, index) => (
                { participationId: mockPartIds[index], poolId: testPoolId, userId, relationshipId })
            )
        };

        const poolCreateLogDef = {
            query: `insert into friend_data.friend_log (log_id, saving_pool_id, relevant_user_id, log_type) values %L`,
            columnTemplate: '${logId}, ${savingPoolId}, ${userId}, *{SAVING_POOL_CREATED}',
            rows: [{ logId: uuid(), savingPoolId: testPoolId, userId: testUserId }]
        };

        const expectedLogRows = testInput.participatingUsers.map(({ userId, relationshipId }) => ({ logId: uuid(), relationshipId, savingPoolId: testPoolId, userId }));
        const poolJoinLogDef = {
            query: `insert into friend_data.friend_log (log_id, saving_pool_id, relationship_id, relevant_user_id, log_type) values %L`,
            columnTemplate: '${logId}, ${savingPoolId}, ${relationshipId}, ${userId}, *{FRIEND_ADDED_TO_POOL}',
            rows: expectedLogRows
        };

        multiTableStub.resolves([
            [{ 'creation_time': testPersistedMoment.format() }],
            [], // no return clause for creating user participation, not needed
            [], // similarly, not needed for other user joins
            [], // or for create log
            [], // or for join logs
        ]);

        const resultOfPersistence = await persistenceWrite.persistNewSavingPool(testInput);
        expect(resultOfPersistence).to.deep.equal({ savingPoolId: testPoolId, persistedTime: testPersistedMoment });

        expect(insertionArgs).to.have.been.calledOnce;
        const insertionArgs = multiTableStub.getCall(0).args;

        expect(insertionArgs).to.have.length(5);
        expect(insertionArgs[0]).to.deep.equal(primaryInputDef);
        expect(insertionArgs[1]).to.deep.equal(joinCreatorDef);
        expect(insertionArgs[2]).to.deep.equal(joinParticipantsDef);
        expect(insertionArgs[3]).to.deep.equal(poolCreateLogDef);
        expect(insertionArgs[4]).to.deep.equal(poolJoinLogDef);
    });

    it('Updates a saving pot name', async () => {
        const mockUpdatedTime = moment();
        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            name: 'Trip to Taipei'
        };

        // to store old values
        const expectedFetchQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';
        queryStub.withArgs(expectedFetchQuery, [testPoolId]).resolves({ poolName: 'Trip to Japan' });

        const expectedUpdateDef = {
            table: 'friend_data.saving_pool',
            key: { savingPoolId },
            value: { poolName: 'Trip to Taipei' },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: uuid(),
            savingPoolId: testPoolId,
            userId: testUserId,
            logContext: { changeFields: [{ fieldName: 'poolName', oldValue: 'Trip to Japan', newValue: 'Trip to Taipei' }]}
        };

        const expectedLogDef = {
            query: `insert into friend_data.friend_log (log_id, saving_pool_id, relevant_user_id, log_type, log_context) values %L`,
            columnTemplate: '${logId}, ${savingPoolId}, ${userId}, *{SAVING_POOL_UPDATE}, ${logContext}',
            rows: [logObject],
        };

        multiOpStub.resolves([
            [{ 'updated_time': mockUpdatedTime.format() }],
            [] // dont need log return
        ]);

        const resultOfUpdate = await handler.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub.getCall(0).args[0]).to.deep.equal(expectedUpdateDef);
        expect(multiOpStub.getCall(0).args[1]).to.deep.equal(expectedLogDef);
    });

    it('Adds someone to a saving pot', async () => {
        const mockUpdatedTime = moment();
        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockRelUser(10)]
        };

        const checkExistenceQuery = 'select participation_id, active from friend_data.saving_pool_participant where saving_pool_id = $1 and user_id = $2';
        queryStub.resolves([]);

        const mockParticipationId = uuid();
        uuidStub.onFirstCall().returns(mockParticipationId);
        const joinParticipantsDef = {
            query: `insert into friend_data.saving_pool_participant (saving_pool_id, user_id, relationship_id) values %L returning creation_time`,
            columnTemplate: '${poolId}, ${userId}, ${relationshipId}',
            rows: [{ participationId: mockParticipationId, poolId: testPoolId, userId: 'user-10', relationshipId: 'relationship-10' }]
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
            query: `insert into friend_data.friend_log (log_id, saving_pool_id, relationship_id, relevant_user_id, log_type) values %L`,
            columnTemplate: '${logId}, ${savingPoolId}, ${relationshipId}, ${userId}, *{FRIEND_ADDED_TO_POOL}',
            rows: [logObject]
        };

        multiTableStub.resolves([
            [{ 'creation_time': mockUpdatedTime.format() }],
            []
        ]);

        const resultOfUpdate = await handler.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(queryStub).to.have.been.calledOnceWithExactly(checkExistenceQuery, [testPoolId, 'user-10']);

        expect(multiTableStub).to.have.been.calledOnce;
        expect(multiTableStub.getCall(0).args[0][0]).to.deep.equal(joinParticipantsDef);
        expect(multiTableStub.getCall(0).args[0][1]).to.deep.equal(poolJoinLogDef);
    });

    it('Does not add someone if they are already part and active', async () => {
        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockRelUser(10)]
        };

        const checkExistenceQuery = 'select participation_id, active from friend_data.saving_pool_participant where saving_pool_id = $1 and user_id = $2';
        queryStub.resolves([{ 'active': true }]);

        await expect(handler.updateSavingPool(testInput)).to.eventually.be.rejectedWith('Attempt to add user when already active part of pool');

        expect(queryStub).to.have.been.calledOnceWithExactly(checkExistenceQuery, [testPoolId, 'user-10']);
        expect(multiTableStub).to.not.have.been.called;
        expect(multiOpStub).to.not.have.been.called;
    });

    it('Flips someone to active if re-added', async () => {
        const mockParticipationId = uuid();
        const mockUpdatedTime = uuid();

        const testInput = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockRelUser(10)]
        };

        const checkExistenceQuery = 'select participation_id, active from friend_data.saving_pool_participant where saving_pool_id = $1 and user_id = $2';

        const updateParticipantDef = {
            table: 'friend_data.saving_pool_participant',
            key: { participationId: mockParticipationId },
            value: { active: true },
            returnClause: 'updated_time'
        };

        const mockLogId = uuid();
        uuidStub.returns(mockLogId);
        const logObject = {
            logId: mockLogId,
            savingPoolId: testPoolId,
            relationshipId: 'relationship-10',
            userId: 'user-10',
            logContext: { reactivation: true }
        };

        const insertLogDef = {
            query: `insert into friend_data.friend_log (log_id, saving_pool_id, relationship_id, relevant_user_id, log_type) values %L`,
            columnTemplate: '${logId}, ${savingPoolId}, ${relationshipId}, ${userId}, *{FRIEND_ADDED_TO_POOL}',
            rows: [logObject]
        };

        queryStub.resolves([{ 'participation_id': mockParticipationId, 'active': false }]);
        
        multiOpStub.resolves([
            [{ 'updated_time': mockUpdatedTime.format() }],
            []
        ]);

        const resultOfUpdate = await handler.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(queryStub).to.have.been.calledOnceWithExactly(checkExistenceQuery, [testPoolId, 'user-10']);
        expect(multiTableStub).to.not.have.been.called;
        
        expect(multiOpStub).to.have.been.calledOnceWithExactly([updateParticipantDef], [insertLogDef]);
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
            key: { savingPoolId },
            value: { targetAmount: 15000 * 10000, targetUnit: 'HUNDREDTH_CENT', targetCurrency: 'EUR' },
            returnClause: 'updated_time'
        };

        const logObject = {
            logId: uuid(),
            savingPoolId: testPoolId,
            userId: testUserId,
            logContext: { changeFields: [{ fieldName: 'targetAmount', oldValue: 10000 * 10000, newValue: 15000 * 10000 }]}
        };

        const expectedLogDef = {
            query: `insert into friend_data.friend_log (log_id, saving_pool_id, relevant_user_id, log_type, log_context)`,
            columnTemplate: '${logId}, ${savingPoolId}, ${userId}, *{SAVING_POOL_UPDATE}, ${logContext}',
            rows: [logObject],
        };

        const resultOfUpdate = await handler.updateSavingPool(testInput);
        expect(resultOfUpdate).to.deep.equal({ updatedTime: moment(mockUpdatedTime.format()) });

        expect(multiOpStub).to.have.been.calledOnce;
        expect(multiOpStub.getCall(0).args[0]).to.deep.equal(expectedUpdateDef);
        expect(multiOpStub.getCall(0).args[1]).to.deep.equal(expectedLogDef);
    });

});

describe('**** UNIT TEST FRIEND SAVING PERSISTENCE, READS ***', async () => {

    // if this starts to strain, we can either unnnest tags to select on & group by tag, but for each call, volumes should
    // easily be low enough to allow the in-memory summation to be fine, but keep an eye out
    const expectedTransactionQuery = `select transaction_id, settlement_time, amount, currency, unit, owner_user_id, tags from ` + 
        `transaction_data.core_transaction_ledger inner join account_data.core_account_ledger ` +
        `on transaction_data.core_transaction_ledger.account_id = account_data.core_account_ledger.account_id ` +
        `where transaction_data.core_transaction_ledger.tags %% $1`; 
    
    const mockTransaction = (poolId, amount, unit = 'HUNDREDTH_CENT') => ({ 'transaction_id': uuid(), 'amount': amount, unit, currency: 'EUR', tag: `SAVING_POOL::${poolId}` });

    beforeEach(() => helper.resetStubs(queryStub));

    it('Finds savings pots (basic details) that user is part of', async () => {
        const expectedQuery = 'select * from friend_data.saving_pool inner join friend_data.saving_pool_participant ' +
            `on friend_data.saving_pool.saving_pool_id = friend_data.saving_pool_participant.saving_pool_id ` +
            `where friend_data.saving_pool.active = true and friend_data.saving_pool_participant.active = true and ` + 
            `friend_data.saving_pool_participant.participant_id = $1`;

        const mockCreationTime1 = moment().subtract(1, 'weeks');
        const mockCreationTime2 = moment().subtract(2, 'weeks');

        const mockPoolsFromPersistence = [
           { 'saving_pool_id': 'pool-1', 'active': true, 'pool_name': 'First pool', 'creation_time': mockCreationTime1.format() },
           { 'saving_pool_id': 'pool-2', 'active': true, 'pool_name': 'Second pool', 'creation_time': mockCreationTime2.format() }
        ];

        queryStub.resolves(mockPoolsFromPersistence);

        const fetchResult = await persistenceRead.fetchSavingPoolsForUser(testUserId);

        const expectedPools = [
            { ...camelcaseKeys(mockPoolsFromPersistence[0]), creationTime: moment(mockCreationTime1.format()) },
            { ...camelcaseKeys(mockPoolsFromPersistence[1]), creationTime: moment(mockCreationTime2.format()) },
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
            mockTransaction('mock-pool-2', 50 * 100, 'WHOLE_CENT'),
        ];
        queryStub.resolves(mockResultsFromPersistence);

        const resultOfQuery = await persistenceRead.calculatedPoolBalances(mockPools);

        const expectedResult = [
            { savingPoolId: 'mock-pool-1', amount: 30 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
            { savingPoolId: 'mock-pool-2', amount: 50 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
            { savingPoolId: 'mock-pool-3', amount: 0, unit: 'HUNDREDTH_CENT', currency: 'EUR' }
        ];

        expect(resultOfQuery).to.deep.equal(expectedResult);
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedTransactionQuery, [expectedTagArray]); // note [[]]
    });

    it('Gets basic details on a savings pool', async () => {
        const expectedQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';

        const mockCreationTime = moment().subtract(2, 'days');
        const mockPool = { 'saving_pool_id': testPoolId, 'creating_user_id': testUserId, 'active': true, 'pool_name': 'First pool', 'creation_time': mockCreationTime.format() };
        queryStub.withArgs(expectedFetchQuery, [testPoolId]).resolves([mockPool]);

        const fetchResult = await persistenceRead.fetchSavingPoolDetails(testPoolId, false);
        expect(fetchResult).to.deep.equal({
            savingPoolId: testPoolId,
            creatingUserid: testUserId,
            active: true,
            poolName: 'First pool',
            creationTime: moment(mockCreationTime.format());
        })

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['mock-pool-id']);
    });

    it('Gets history (all relevant info) on saving pot, including participants', async () => {
        const expectedFetchQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';
        const expectedParticipantQuery = 'select user_id, relationship_id from friend_data.saving_pool_participant ' +
            'where saving_pool_id = $1';
        const expectedContributionQuery = expectedTransactionQuery;

        const mockCreationTime = moment().subtract(1, 'week');
        const mockPool = { 'saving_pool_id': testPoolId, 'creating_user_id': testUserId, 'active': true, 'pool_name': 'First pool', 'creation_time': mockCreationTime.format() };
        queryStub.withArgs(expectedFetchQuery, [testPoolId]).resolves([mockPool]);
        
        const mockParticipants = [{ 'user_id': testUserId }, { 'user_id': 'user-1', 'relationship_id': 'rel-1' }, { 'user_id': 'user-2', 'relationship_id': 'rel-2' }];
        queryStub.withArgs(expectedParticipantQuery, [testPoolId]).resolves(mockParticipants);

        const mockTxTimes = [moment().subtract(1, 'week'), moment().subtract(3, 'days')];
        const mockTransactions = [
            { ...mockTransaction(testPoolId, 10), 'owner_user_id': testUserId, 'settlement_time': mockTxTimes[0].format() }, 
            { ...mockTransaction(testPoolId, 20), 'owner_user_id': 'user-2', 'settlement_time': mockTxTimes[1].format() }
        ];
        queryStub.withArgs(expectedContributionQuery, [[`SAVING_POOL::${testPoolId}`]]).resolves(mockTransactions);

        const fetchResult = await persistenceRead.fetchSavingPoolDetails(testPoolId, true);

        const expectedResult = {
            savingPoolId: testPoolId,
            creationTime: moment(mockCreationTime.format()),
            creatingUserId: testUserId,
            
            targetAmount: 50 * 10000,
            targetUnit: 'HUNDREDTH_CENT',
            targetCurrency: 'EUR',
            
            currentAmount: 30 * 10000,
            currentUnit: 'HUNDREDTH_CENT',
            currentCurrency: 'EUR',
            
            participatingUsers: [
                { userId: testUserId }, 
                { userId: 'user-1', relationshipId: 'rel-1' },
                { userId: 'user-2', relationshipId: 'rel-2' }
            ],

            transactionRecord: [
                { ownerUserid: 'user-1', settlementTime: moment(mockTxTimes[0].format()), amount: 10 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
                { ownerUserid: 'user-2', settlementTime: moment(mockTxTimes[1].format()), amount: 20 * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' },
            ]
        };

        expect(fetchResult).to.deep.equal(expectedResult);

        expect(queryStub).to.have.been.calledWith(expectedFetchQuery, [testPoolId]);
        expect(queryStub).to.have.been.calledWith(expectedParticipantQuery, [testPoolId]);
        expect(queryStub).to.have.been.calledWith(expectedContributionQuery, [[`SAVING_POOL::${testPoolId}`]]); // note [[]]
    });

    // useful aux method, first written for here
    it('Gets user IDs for set of friendships based on calling user id', async () => {
        const expectedFetchQuery = 'select initiated_user_id, accepted_user_id, relationship_id from ' +
            `friend_data.core_friend_relatinship relationship_status = $1 and (initiated_user_id = $2) or (accepted_user_id = $2) ` +
            `and relationship_id in (${util.extractArrayIndices(['rel-1', 'rel-2', 'rel-3'])})`;

        const mockRows = [
            { 'initiated_user_id': testUserId, 'accepted_user_id': 'user-1', 'relationship_id': 'rel-1' },
            { 'initiated_user_id': 'user-2', 'accepted_user_id': testUserId, 'relationship_id': 'rel-2' }
        ];

        queryStub.resolves(mockRows);

        const fetchResult = await persistenceRead.obtainFriendIds(testUserId, ['rel-1', 'rel-2', 'rel-3']);
        expect(fetchResult).to.deep.equal([{ userId: 'user-1', relationshipId: 'rel-1' }, { userId: 'user-2', relationshipId: 'rel-2' }]);
        
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedFetchQuery, ['ACTIVE', testUserId]);
    });

});