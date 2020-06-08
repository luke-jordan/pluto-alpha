'use strict';

const uuid = require('uuid/v4');
const moment = require('moment');

const helper = require('./test-helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const extractFriendIdsStub = sinon.stub();
const persistFriendSavingStub = sinon.stub();
const updateSavingPoolStub = sinon.stub();
const removeTransactionStub = sinon.stub();

const listSavingPoolsStub = sinon.stub();
const calculatePoolBalancesStub = sinon.stub();
const fetchSavingPoolStub = sinon.stub();

const fetchProfileStub = sinon.stub();

const publishSingleEventStub = sinon.stub();
const publishMultiEventStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../friend-saving-handler', {
    './persistence/write.friends.pools.js': {
        'persistNewSavingPool': persistFriendSavingStub,
        'updateSavingPool': updateSavingPoolStub,
        'removeTransactionsFromPool': removeTransactionStub
    },
    './persistence/read.friends.js': {
        'obtainFriendIds': extractFriendIdsStub,
        'fetchSavingPoolsForUser': listSavingPoolsStub,
        'fetchSavingPoolDetails': fetchSavingPoolStub,
        'calculatePoolBalances': calculatePoolBalancesStub,
        'fetchUserProfile': fetchProfileStub
    },
    'publish-common': {
        'publishUserEvent': publishSingleEventStub,
        'publishMultiUserEvent': publishMultiEventStub
    }
});

const mockAmountDict = (amount, currency = 'EUR') => (
    { amount: amount * 10000, unit: 'HUNDREDTH_CENT', currency }
);

const mockAmountSpread = (amount, prefix, currency = 'EUR') => (
    { [`${prefix}Amount`]: amount * 10000, [`${prefix}Unit`]: 'HUNDREDTH_CENT', [`${prefix}Currency`]: currency }
);

const testUserId = uuid();

describe('*** UNIT TEST COLLECTIVE SAVING, BASIC OPERATIONS, POSTS ***', () => {

    beforeEach(() => helper.resetStubs(extractFriendIdsStub, persistFriendSavingStub, updateSavingPoolStub, fetchSavingPoolStub, publishSingleEventStub, publishMultiEventStub));

    it('Unit test creating a friend savings pot', async () => {
        const mockFriendships = ['relationship-1', 'relationship-2', 'relationship-3'];
        const mockUsers = ['user-1', 'user-2', 'user-3'];

        const testBody = {
            name: 'Trip to Japan ',
            target: {
                amount: 10000,
                unit: 'WHOLE_CURRENCY',
                currency: 'ZAR'
            },
            friendships: mockFriendships
        };

        const expectedPersistenceParams = {
            poolName: 'Trip to Japan',
            creatingUserId: testUserId,
            targetAmount: 10000,
            targetUnit: 'WHOLE_CURRENCY',
            targetCurrency: 'ZAR',
            participatingUsers: mockFriendships.map((relationshipId, index) => ({ relationshipId, userId: mockUsers[index] }))
        };

        const mockPersistedTime = moment();
        const mockPoolId = uuid();
        const mockPersistenceResult = { savingPoolId: mockPoolId, persistedTime: mockPersistedTime };

        extractFriendIdsStub.resolves(mockFriendships.map((relationshipId, index) => ({ userId: mockUsers[index], relationshipId })));
        persistFriendSavingStub.resolves(mockPersistenceResult);

        // these are so the consumer can stick the pool directly into its list, deeper tests are below in read section
        fetchSavingPoolStub.resolves({ 
            savingPoolId: mockPoolId, 
            creationTime: mockPersistedTime,
            creatingUserId: testUserId,
            poolName: 'Trip to Japan',
            ...mockAmountSpread(1, 'target', 'ZAR'),
            ...mockAmountSpread(0, 'current', 'ZAR'),
            participatingUsers: [...expectedPersistenceParams.participatingUsers, { userId: testUserId }],
            transactionRecord: []
        });
        fetchProfileStub.resolves({ personalName: 'A', familyName: 'User' });

        const testEvent = helper.wrapParamsWithPath(testBody, 'create', testUserId);
        const resultOfCreation = await handler.writeSavingPool(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfCreation);

        const expectedPool = {
            savingPoolId: mockPoolId,
            creationTimeMillis: mockPersistedTime.valueOf(),
            createdByFetcher: true,
            poolName: 'Trip to Japan',
            creatingUser: { personalName: 'A', familyName: 'User', relationshipId: 'CREATOR' },
            current: { amount: 0, unit: 'HUNDREDTH_CENT', currency: 'ZAR' },
            target: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'ZAR' },
            participatingUsers: [...mockFriendships, 'CREATOR'].map((relationshipId) => ({ personalName: 'A', familyName: 'User', relationshipId })),
            transactionRecord: []
        };
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', createdSavingPool: expectedPool });

        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(testUserId, mockFriendships);
        expect(persistFriendSavingStub).to.have.been.calledOnceWithExactly(expectedPersistenceParams);

        const expectedCreationContext = { savingPoolId: mockPoolId };
        const expectedFriendAddedContext = { 
            savingPoolId: mockPoolId,
            messageParameters: { poolName: 'Trip to Japan', friendName: 'A' }
        };
        const expectedFriendOptions = { context: expectedFriendAddedContext, initiator: testUserId };

        expect(publishSingleEventStub).to.have.been.calledOnceWithExactly(testUserId, 'CREATED_SAVING_POOL', { context: expectedCreationContext });
        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(mockUsers, 'ADDED_TO_FRIEND_SAVING_POOL', expectedFriendOptions);
    });

    it('Unit testing disallows pot where user is not in a friendship', async () => {
        const mockFriendships = ['relationship-1', 'relationship-2', 'relationship-3'];
        // user 3 is missing, so friendship 3 must not include the calling user
        const mockUsers = [
            { userId: 'user-1', relationshipId: 'relationship-1' }, 
            { userId: 'user-2', relationshipId: 'relationship-2' }
        ];

        const testBody = {
            name: 'Attempted laundering scheme',
            target: {
                amount: 1000000,
                unit: 'WHOLE_CURRENCY',
                currency: 'ZAR'
            },
            friendships: mockFriendships
        };
        
        extractFriendIdsStub.resolves(mockUsers);

        const testEvent = helper.wrapParamsWithPath(testBody, 'create', testUserId);
        const resultOfAttempt = await handler.writeSavingPool(testEvent);

        // 403 logs the user out, so send bad request (also, no ability to trigger this from front-end, so does not need message)
        const bodyMsg = JSON.stringify({ result: 'ERROR', message: 'User trying to involve non-friends' });
        expect(resultOfAttempt).to.deep.equal({ statusCode: 400, body: bodyMsg }); 

        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(testUserId, mockFriendships);
        expect(persistFriendSavingStub).to.not.have.been.called;
    });

    it('Unit test adding someone to a savings pot', async () => {
        const testPoolId = uuid();
        
        // arrays so can pass in multiple
        const mockFriendship = ['relationship-N'];
        const mockFriendUserPair = { relationshipId: 'relationship-N', userId: 'user-N' };
        const mockUpdatedTime = moment();

        const testBody = {
            savingPoolId: testPoolId,
            friendshipsToAdd: mockFriendship
        };

        const expectedToPersistence = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockFriendUserPair]
        };

        fetchSavingPoolStub.onFirstCall().resolves({ creatingUserId: testUserId, poolName: 'Trip to Japan' });
        extractFriendIdsStub.resolves([mockFriendUserPair]);
        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        const updatedPool = { poolName: 'Trip to Japan', participatingUsers: ['with-that-new-friend'] };
        fetchSavingPoolStub.onSecondCall().resolves(updatedPool);

        fetchProfileStub.withArgs({ systemWideUserId: testUserId }).resolves({ calledName: 'Some', familyName: 'Person' });

        const testEvent = helper.wrapParamsWithPath(testBody, 'update', testUserId);
        const resultOfUpdate = await handler.writeSavingPool(testEvent);

        const resultBody = helper.standardOkayChecks(resultOfUpdate);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updatedTime: mockUpdatedTime.valueOf(), updatedPool });

        expect(fetchSavingPoolStub).to.have.been.calledTwice;
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, false);
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, true);

        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(testUserId, mockFriendship);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedToPersistence);

        const modContext = { savingPoolId: testPoolId, friendUserIds: [mockFriendUserPair] };
        const expectedFriendAddedContext = { 
            savingPoolId: testPoolId,
            messageParameters: { poolName: 'Trip to Japan', friendName: 'Some' }
        };
        const friendLogOptions = { initiator: testUserId, context: expectedFriendAddedContext };

        expect(publishSingleEventStub).to.have.been.calledOnceWithExactly(testUserId, 'MODIFIED_SAVING_POOL', { context: modContext });
        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(['user-N'], 'ADDED_TO_FRIEND_SAVING_POOL', friendLogOptions);
    });

    it('Unit test renaming a saving pot', async () => {
        const testPoolId = uuid();

        const testBody = {
            savingPoolId: testPoolId,
            name: 'Trip to Taipei'
        };

        const expectedToPersistence = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            poolName: 'Trip to Taipei'
        };

        const mockUpdatedTime = moment();

        fetchSavingPoolStub.onFirstCall().resolves({ creatingUserId: testUserId, poolName: 'Trip to Tokyo' });
        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        const updatedPool = { creatingUserId: testUserId, poolName: 'Trip to Taipei' };
        fetchSavingPoolStub.onSecondCall().resolves(updatedPool);

        const testEvent = helper.wrapParamsWithPath(testBody, 'update', testUserId);
        const resultOfAttempt = await handler.writeSavingPool(testEvent);

        const resultBody = helper.standardOkayChecks(resultOfAttempt);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updatedTime: mockUpdatedTime.valueOf(), updatedPool });

        expect(fetchSavingPoolStub).to.have.been.calledTwice;
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, false);
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, true);
        
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedToPersistence);

        const expectedContext = { savingPoolId: testPoolId, priorName: 'Trip to Tokyo', newName: 'Trip to Taipei' };
        expect(publishSingleEventStub).to.have.been.calledOnceWithExactly(testUserId, 'MODIFIED_SAVING_POOL', { context: expectedContext });
    });

    it('Unit test changing a goal for a saving pot', async () => {
        const testPoolId = uuid();

        const testBody = {
            savingPoolId: testPoolId,
            target: {
                amount: 15000,
                unit: 'WHOLE_CURRENCY',
                currency: 'ZAR'
            }
        };

        const expectedUpdateArg = { 
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            targetAmount: 15000, 
            targetUnit: 'WHOLE_CURRENCY', 
            targetCurrency: 'ZAR' 
        };

        const mockUpdatedTime = moment();

        fetchSavingPoolStub.onFirstCall().resolves({ creatingUserId: testUserId });
        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        const updatedPool = { targetAmount: 15000, targetUnit: 'WHOLE_CURRENCY', targetCurrency: 'ZAR' };
        fetchSavingPoolStub.onSecondCall().resolves(updatedPool);

        const testEvent = helper.wrapParamsWithPath(testBody, 'update', testUserId);
        const resultOfAttempt = await handler.writeSavingPool(testEvent);

        const resultBody = helper.standardOkayChecks(resultOfAttempt);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updatedTime: mockUpdatedTime.valueOf(), updatedPool });

        expect(fetchSavingPoolStub).to.have.been.calledTwice;
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, false);

        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedUpdateArg);
    });

    it('Rejects attempts to update by non-creating user', async () => {
        const testPoolId = uuid();
        const testOtherUserId = uuid();

        const testBody = {
            savingPoolId: testPoolId,
            friendshipsToAdd: ['some-dodgy-friendship']
        };

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });

        const testEvent = helper.wrapParamsWithPath(testBody, 'update', testOtherUserId);
        const resultOfAttempt = await handler.writeSavingPool(testEvent);

        const bodyMsg = { result: 'ERROR', message: 'Trying to modify pool but not creator' };
        expect(resultOfAttempt).to.deep.equal({ statusCode: 400, body: JSON.stringify(bodyMsg) });
        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, false);
        expect(updateSavingPoolStub).to.not.have.been.called;
        expect(removeTransactionStub).to.not.have.been.called;
    });
});

describe('*** UNIT TEST DEACTIVATION AND REMOVAL ***', () => {

    beforeEach(() => helper.resetStubs(fetchSavingPoolStub, updateSavingPoolStub, removeTransactionStub, publishSingleEventStub, publishMultiEventStub));

    it('Unit test removing people from pot', async () => {
        const testPoolId = uuid();
        const mockUpdatedTime = moment();

        const mockFriendship = 'relationship-N';
        const mockFriendUserPair = { relationshipId: 'relationship-N', userId: 'user-N' };

        const mockTransactions = [{ ownerUserId: testUserId, transactionId: 'tx-1' }, { ownerUserId: 'user-N', transactionId: 'tx-2' }];
        
        const testBody = {
            savingPoolId: testPoolId,
            friendshipToRemove: mockFriendship
        };

        const expectedToPersistence = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToRemove: [mockFriendUserPair]
        };

        fetchSavingPoolStub.withArgs(testPoolId, false).resolves({ creatingUserId: testUserId, poolName: 'Trip to Japan' });
        const poolWithDetails = { participatingUsers: [mockFriendUserPair], transactionRecord: mockTransactions, poolName: 'Trip to Japan' };
        fetchSavingPoolStub.withArgs(testPoolId, true).resolves(poolWithDetails); // not significant to make sure 3rd call is diff

        extractFriendIdsStub.resolves([mockFriendUserPair]);
        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        fetchProfileStub.withArgs({ systemWideUserId: testUserId }).resolves({ calledName: 'Some', familyName: 'Person' });

        const testEvent = helper.wrapParamsWithPath(testBody, 'update', testUserId);
        const resultOfUpdate = await handler.writeSavingPool(testEvent);

        const resultBody = helper.standardOkayChecks(resultOfUpdate);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updatedTime: mockUpdatedTime.valueOf(), updatedPool: poolWithDetails });

        expect(fetchSavingPoolStub).to.have.been.calledThrice;
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, false); // standard check on this path
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, true); // to get transactions, so can remove them, later to return updated pool

        expect(removeTransactionStub).to.have.been.calledOnceWithExactly(testPoolId, ['tx-2']);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedToPersistence);

        // we don't include message parameters because this is a silent operation
        const modContext = { savingPoolId: testPoolId, removedFriend: [mockFriendUserPair] };
        const friendContext = { savingPoolId: testPoolId, messageParameters: { poolName: 'Trip to Japan', friendName: 'Some' } };
        const friendLogOptions = { initiator: testUserId, context: friendContext };

        expect(publishSingleEventStub).to.have.been.calledTwice;
        expect(publishSingleEventStub).to.have.been.calledWithExactly(testUserId, 'MODIFIED_SAVING_POOL', { context: modContext });
        expect(publishSingleEventStub).to.have.been.calledWithExactly('user-N', 'REMOVED_FROM_FRIEND_SAVING_POOL', friendLogOptions);
    });

    it('Unit test removing a transaction', async () => {
        const testPoolId = uuid();
        const mockUserId = 'user-2';
        const mockUpdatedTime = moment();

        const testBody = {
            savingPoolId: testPoolId,
            transactionId: 'transaction-id'
        };

        const mockUsers = [{ userId: 'user-2', relationshipId: 'rel-1' }];
        const mockTxRecord = [{ ownerUserId: testUserId, transactionId: 'some-tx' }, { ownerUserId: 'user-2', transactionId: 'transaction-id' }];

        const expectedTxRecord = [{ ownerUserId: testUserId, transactionId: 'some-tx' }];
        const expectedRevisedPool = { participatingUsers: mockUsers, transactionRecord: expectedTxRecord };

        fetchSavingPoolStub.onFirstCall().resolves({ participatingUsers: mockUsers, transactionRecord: mockTxRecord });
        fetchSavingPoolStub.onSecondCall().resolves(expectedRevisedPool);

        removeTransactionStub.resolves({ updatedTime: mockUpdatedTime });

        const testEvent = helper.wrapParamsWithPath(testBody, 'retract', mockUserId);
        const resultOfRetract = await handler.writeSavingPool(testEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfRetract);
        
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updatedTime: mockUpdatedTime.valueOf(), updatedPool: expectedRevisedPool });
        
        expect(fetchSavingPoolStub).to.have.been.calledTwice;
        expect(fetchSavingPoolStub).to.have.been.calledWithExactly(testPoolId, true);
        expect(removeTransactionStub).to.have.been.calledOnceWithExactly(testPoolId, ['transaction-id']);
        expect(updateSavingPoolStub).to.not.have.been.called;

        const expectedContext = { savingPoolId: testPoolId, transactionId: 'transaction-id' };
        expect(publishSingleEventStub).to.have.been.calledOnceWithExactly('user-2', 'RETRACTED_FROM_SAVING_POOL', { context: expectedContext });
    });
    
    it('Unit test deactivating a pot', async () => {
        const testPoolId = uuid();
        const mockUpdatedTime = moment();

        const expectedToPersistence = {
            savingPoolId: testPoolId,
            active: false
        };

        const mockUserIdResults = [{ userId: testUserId, relationshipId: 'CREATOR' }, { userId: 'some-user', relationshipId: 'relationship-1' }];

        fetchSavingPoolStub.onFirstCall().resolves({ 
            savingPoolId: testPoolId, 
            creatingUserId: testUserId, 
            poolName: 'Old Pot',
            participatingUsers: mockUserIdResults
        });

        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        fetchProfileStub.withArgs({ systemWideUserId: testUserId }).resolves({ calledName: 'Deactivate', familyName: 'This' });

        const testEvent = helper.wrapParamsWithPath({ savingPoolId: testPoolId }, 'deactivate', testUserId);
        
        const resultOfUpdate = await handler.writeSavingPool(testEvent);
        
        const resultBody = helper.standardOkayChecks(resultOfUpdate);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS', updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledWith(testPoolId, true);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedToPersistence);
        
        // for the moment we leave the transactions, as does not block, and preserves record, in case want to reverse (or check)
        expect(removeTransactionStub).to.not.have.been.called;

        const modContext = { savingPoolId: testPoolId, active: false };
        expect(publishSingleEventStub).to.have.been.calledOnceWithExactly(testUserId, 'DEACTIVATED_SAVING_POOL', { context: modContext });
        
        const messageParameters = { friendName: 'Deactivate', poolName: 'Old Pot' };
        const friendContext = { savingPoolId: testPoolId, messageParameters };
        const friendLogOptions = { initiator: testUserId, context: friendContext };

        expect(publishMultiEventStub).to.have.been.calledOnceWithExactly(['some-user'], 'SAVING_POOL_DEACTIVATED_BY_CREATOR', friendLogOptions);
    });

});

describe('*** UNIT TEST COLLECTIVE SAVING, FETCHES ***', () => {

    beforeEach(() => helper.resetStubs(listSavingPoolsStub, calculatePoolBalancesStub, fetchSavingPoolStub, fetchProfileStub));

    const testEvent = (path, systemWideUserId, queryStringParameters) => ({
        requestContext: {
            authorizer: { systemWideUserId }
        },
        httpMethod: 'GET',
        pathParameters: {
            proxy: path
        },
        queryStringParameters   
    });

    it('Unit test getting a list of saving pots with their saved amounts', async () => {
        const testCreatedMoment1 = moment().subtract(5, 'days');
        const testCreatedMoment2 = moment().subtract(3, 'weeks');
        
        const mockPoolsFromPersistence = [
            { savingPoolId: 'pool-1', poolName: 'Pool 1', ...mockAmountSpread(100, 'target'), creationTime: testCreatedMoment1 },
            { savingPoolId: 'pool-2', poolName: 'Pool 2', ...mockAmountSpread(30, 'target'), creationTime: testCreatedMoment2 }
        ];

        const mockBalancesFromPersistence = [
            { savingPoolId: 'pool-1', ...mockAmountDict(20) },
            { savingPoolId: 'pool-2', ...mockAmountDict(35) }
        ];

        const expectedPoolsToConsumer = [
            { savingPoolId: 'pool-1', poolName: 'Pool 1', target: mockAmountDict(100), current: mockAmountDict(20), creationTimeMillis: testCreatedMoment1.valueOf() },
            { savingPoolId: 'pool-2', poolName: 'Pool 2', target: mockAmountDict(30), current: mockAmountDict(35), creationTimeMillis: testCreatedMoment2.valueOf() }
        ];

        listSavingPoolsStub.resolves(mockPoolsFromPersistence);
        calculatePoolBalancesStub.resolves(mockBalancesFromPersistence);
        
        const resultOfFetch = await handler.readSavingPool(testEvent('list', testUserId));
        const resultBody = helper.standardOkayChecks(resultOfFetch);
        expect(resultBody).to.deep.equal({ currentSavingPools: expectedPoolsToConsumer });

        expect(listSavingPoolsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

    it('Unit test getting a saving pot details', async () => {
        const testPoolId = 'pool-id';

        const mockCreationTime = moment().subtract(2, 'weeks');
        const mockSaveTimes = [moment().subtract(3, 'days'), moment().subtract(2, 'weeks'), moment().subtract(1, 'days')];
        const mockSaveIds = [uuid(), uuid(), uuid()];

        const mockPoolFromPersistence = {
            savingPoolId: 'pool-id',
            poolName: '2021 holiday',
            creationTime: mockCreationTime,
            creatingUserId: 'some-other-user',
            ...mockAmountSpread(100, 'target'),
            ...mockAmountSpread(20, 'current'),
            participatingUsers: [{ userId: 'some-other-user' }, { userId: testUserId, relationshipId: 'rel-0'}, { userId: 'some-user-2', relationshipId: 'rel-1' }, { userId: 'some-user-3', relationshipId: 'rel-2' }],
            transactionRecord: [
                { transactionId: mockSaveIds[0], ownerUserId: 'some-user-2', ...mockAmountDict(5), settlementTime: mockSaveTimes[0] },
                { transactionId: mockSaveIds[1], ownerUserId: 'some-other-user', ...mockAmountDict(5), settlementTime: mockSaveTimes[1] },
                { transactionId: mockSaveIds[2], ownerUserId: testUserId, ...mockAmountDict(10), settlementTime: mockSaveTimes[2] }
            ]
        };

        // NOTE : these relationship IDs are from the _creator_ of the pool to the participating user (if this becomes important in future, one extra call can replace them)
        const mockProfiles = {
            'some-other-user': { personalName: 'Another', familyName: 'Person', relationshipId: 'CREATOR' },
            [testUserId]: { personalName: 'Calling', familyName: 'User', relationshipId: 'rel-0' },
            'some-user-2': { personalName: 'Thisone', familyName: 'That', relationshipId: 'rel-1' },
            'some-user-3': { personalName: 'Oneorother', familyName: 'Here', relationshipId: 'rel-2' }
        };

        const expectedResult = {
            savingPoolId: 'pool-id',
            poolName: '2021 holiday',
            creationTimeMillis: mockCreationTime.valueOf(),
            createdByFetcher: false,
            creatingUser: { personalName: 'Another', familyName: 'Person', relationshipId: 'CREATOR' },
            target: mockAmountDict(100),
            current: mockAmountDict(20),
            participatingUsers: Object.values(mockProfiles),
            transactionRecord: [
                { transactionId: mockSaveIds[0], saveBySelf: false, saverName: 'Thisone That', saveAmount: mockAmountDict(5), creationTimeMillis: mockSaveTimes[0].valueOf() },
                { transactionId: mockSaveIds[1], saveBySelf: false, saverName: 'Another Person', saveAmount: mockAmountDict(5), creationTimeMillis: mockSaveTimes[1].valueOf() },
                { transactionId: mockSaveIds[2], saveBySelf: true, saverName: 'Calling User', saveAmount: mockAmountDict(10), creationTimeMillis: mockSaveTimes[2].valueOf() }
            ]
        };

        Object.keys(mockProfiles).forEach((userId) => fetchProfileStub.withArgs({ systemWideUserId: userId }).resolves(mockProfiles[userId]));
        fetchSavingPoolStub.resolves(mockPoolFromPersistence);

        const resultOfFetch = await handler.readSavingPool(testEvent('fetch', testUserId, { savingPoolId: testPoolId }));
        const resultBody = helper.standardOkayChecks(resultOfFetch);
        expect(resultBody).to.deep.equal(expectedResult);

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly('pool-id', true); // flag says want full details
        expect(fetchProfileStub).to.have.callCount(4);
        expect(fetchProfileStub).to.have.been.calledWith({ systemWideUserId: testUserId });
        expect(fetchProfileStub).to.have.been.calledWith({ systemWideUserId: 'some-other-user' });
        expect(fetchProfileStub).to.have.been.calledWith({ systemWideUserId: 'some-user-2' });
        expect(fetchProfileStub).to.have.been.calledWith({ systemWideUserId: 'some-user-3' });
    });

    it('Unit test forbidding a saving pot fetch if user is not part of it', async () => {
        const testPoolId = 'pool-id';

        const mockCreationTime = moment().subtract(2, 'weeks');
        const mockSaveTimes = [moment().subtract(3, 'days'), moment().subtract(2, 'weeks'), moment().subtract(1, 'days')];
        const mockSaveIds = [uuid(), uuid(), uuid()];

        const mockPoolFromPersistence = {
            savingPoolId: 'pool-id',
            poolName: '2021 holiday',
            creationTime: mockCreationTime,
            creatingUserId: 'some-other-user',
            ...mockAmountSpread(100, 'target'),
            ...mockAmountSpread(20, 'current'),
            participatingUsers: [{ userId: 'some-other-user' }, { userId: testUserId, relationshipId: 'rel-0'}, { userId: 'some-user-2', relationshipId: 'rel-1' }, { userId: 'some-user-3', relationshipId: 'rel-2' }],
            transactionRecord: [
                { transactionId: mockSaveIds[0], ownerUserId: 'some-user-2', ...mockAmountDict(5), settlementTime: mockSaveTimes[0] },
                { transactionId: mockSaveIds[1], ownerUserId: 'some-other-user', ...mockAmountDict(5), settlementTime: mockSaveTimes[1] },
                { transactionId: mockSaveIds[2], ownerUserId: testUserId, ...mockAmountDict(10), settlementTime: mockSaveTimes[2] }
            ]
        };

        fetchSavingPoolStub.resolves(mockPoolFromPersistence);

        const resultOfFetch = await handler.readSavingPool(testEvent('fetch', 'dodgy-spying-user', { savingPoolId: testPoolId }));
        expect(resultOfFetch).to.deep.equal({ statusCode: 400, message: 'Bad request' });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly('pool-id', true); // flag says want full details
        expect(fetchProfileStub).to.not.have.been.called;
    });

});
