'use strict';

const uuid = require('uuid/v4');

const helper = require('./test-helper');
const util = require('ops-util-common');

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
    const expectedTransactionQuery = `select transaction_id, amount, currency, unit, owner_user_id from ` + 
        `transaction_data.core_transaction_ledger inner join account_data.core_account_ledger ` +
        `on transaction_data.core_transaction_ledger.account_id = account_data.core_account_ledger.account_id ` +
        `where transaction_data.core_transaction_ledger.tags %% $1`; 

    it('Finds savings pots (basic details) that user is part of', async () => {
        const expectedQuery = 'select * from friend_data.saving_pool inner join friend_data.saving_pool_participant ' +
            `on friend_data.saving_pool.saving_pool_id = friend_data.saving_pool_participant.saving_pool_id ` +
            `where friend_data.saving_pool.active = true and friend_data.saving_pool_participant.active = true and ` + 
            `friend_data.saving_pool_participant.participant_id = $1`;

        const fetchResult = await persistenceRead.fetchSavingPoolsForUser(testUserId);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, [testUserId]);
    });

    it('Calculates balance of set of savings pools', async () => {
        const mockPools = ['mock-pool-1', 'mock-pool-2', 'mock-pool-3'];
        
        const expectedTagArray = mockPools.map((poolId) => `SAVING_POOL::${poolId}`);

        const resultOfQuery = await persistenceRead.calculatedPoolBalances(mockPools);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedTransactionQuery, [expectedTagArray]); // note [[]]
    });

    it('Gets basic details on a savings pool', async () => {
        const expectedQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';

        const fetchResult = await persistenceRead.fetchSavingPoolDetails(testPoolId, false);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['mock-pool-id']);
    });

    it('Gets history (all relevant info) on saving pot, including participants', async () => {
        const expectedFetchQuery = 'select * from friend_data.saving_pool where saving_pool_id = $1';
        const expectedParticipantQuery = 'select user_id, relationship_id from friend_data.saving_pool_participant ' +
            'where saving_pool_id = $1';
        const expectedContributionQuery = expectedTransactionQuery;

        const fetchResult = await persistenceRead.fetchSavingPoolDetails(testPoolId, true);

        expect(queryStub).to.have.been.calledWith(expectedFetchQuery, [testPoolId]);
        expect(queryStub).to.have.been.calledWith(expectedParticipantQuery, [testPoolId]);
        expect(queryStub).to.have.been.calledWith(expectedContributionQuery, [[`SAVING_POOL::${testPoolId}`]]); // note [[]]
    });

    // useful aux method, first written for here
    it('Gets user IDs for set of friendships based on calling user id', async () => {
        const fetchResult = await persistenceRead.obtainFriendIds(testUserId);
    });

});
