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

const listSavingPoolsStub = sinon.stub();
const calculatePoolBalancesStub = sinon.stub();
const fetchSavingPoolStub = sinon.stub();

const fetchProfileStub = sinon.stub();

const handler = proxyquire('../friend-saving-handler', {
    './persistence/write.friends.js': {
        'persistNewSavingPool': persistFriendSavingStub,
        'updateSavingPool': updateSavingPoolStub,
    },
    './persistence/read.friends.js': {
        'obtainFriendIds': extractFriendIdsStub,
        'fetchSavingPoolsForUser': listSavingPoolsStub,
        'fetchSavingPoolDetails': fetchSavingPoolStub,
        'calculatedPoolBalances': calculatePoolBalancesStub,
    },
});

const testUserId = uuid();

describe('*** UNIT TEST COLLECTIVE SAVING, BASIC OPERATIONS, POSTS ***', () => {

    beforeEach(() => helper.resetStubs(extractFriendIdsStub, persistFriendSavingStub));

    it('Unit test creating a friend savings pot', async () => {
        const mockFriendships = ['relationship-1', 'relationship-2', 'relationship-3'];
        const mockUsers = ['user-1', 'user-2', 'user-3'];

        const testBody = {
            name: 'Trip to Japan',
            target: {
                amount: 10000,
                unit: 'WHOLE_CURRENCY',
                currency: 'ZAR'
            },
            friendships: mockFriendships
        };

        const expectedPersistenceParams = {
            name: 'Trip to Japan',
            creatingUserid: testUserId,
            targetAmount: 10000,
            targetUnit: 'WOHLE_CURRENCY',
            targetCurrency: 'ZAR',
            participatingUsers: mockFriendships.map((relationshipId, index) => ({ relationshipId, userId: mockUsers[index] }))
        };

        const mockPersistenceResult = { savingPoolId: uuid(), persistedTime: moment() };

        extractFriendIdsStub.resolves(mockUsers);
        persistFriendSavingStub.resolves(mockPersistenceResult);

        const resultOfCreation = await handler.createSavingPool(helper.wrapEvent(testBody, testUserId));
        const resultBody = helper.standardOkayChecks(resultOfCreation);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS', persistedValues: mockPersistenceResult })

        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(mockFriendships);
        expect(persistFriendSavingStub).to.have.been.calledOnceWithExactly(expectedPersistenceParams);
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

        const resultOfAttempt = await handler.createSavingPool(helper.wrapEvent(testBody, testUserId));

        // 403 logs the user out, so send bad request (also, no ability to trigger this from front-end, so does not need message)
        expect(resultOfAttempt).to.deep.equal({ statusCode: 400 }); 

        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(mockFriendships);
        expect(persistFriendSavingStub).to.not.have.been.called;
    });

    it('Unit test adding someone to a savings pot', async () => {
        const testPoolId = uuid();
        
        // arrays so can pass in multiple
        const mockFriendship = ['relationship-N'];
        const mockFriendUserPair = { relationshipId: 'relationship-N', userId: 'user-N' };

        const testBody = {
            savingPoolId: testPoolId,
            friendshipsToAdd: mockFriendship
        };

        const expectedToPersistence = {
            savingPoolId: testPoolId,
            updatingUserId: testUserId,
            friendshipsToAdd: [mockFriendUserPair]
        };

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });
        extractFriendIdsStub.resolves([mockFriendUserPair]);
        updateSavingPoolStub.resolves({ updatedTime: moment() });

        const resultOfUpdate = await handler.updateSavingPool(helper.wrapEvent(testBody), testUserId);

        const resultBody = helper.standardOkayChecks(resultOfUpdate);
        expect(resultBody).to.deep.equal({ updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, false);
        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(mockFriendship);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedToPersistence);
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
            name: 'Trip to Taipei'
        };

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });
        updateSavingPoolStub.resolves({ updatedTime: moment() });

        const resultOfAttempt = await handler.updateSavingPool(helper.wrapEvent(testBody, testUserId));

        const resultBody = helper.standardOkayChecks(resultOfAttempt);
        expect(resultBody).to.deep.equal({ updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, false);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(expectedToPersistence);
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

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });
        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        const resultOfAttempt = await handler.updateSavingPool(helper.wrapEvent(testBody, testUserId));
        const resultBody = helper.standardOkayChecks(resultOfAttempt);

        expect(resultBody).to.deep.equal({ updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, false);

        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, { ...expectedUpdateArg });
    });

    it('Rejects attempts to update by non-creating user', async () => {
        const testPoolId = uuid();
        const testOtherUserId = uuid();

        const testBody = {
            savingPoolId: testPoolId,
            friendshipsToAdd: ['some-dodgy-friendship']
        };

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });

        const resultOfAttempt = await handler.updateSavingPool(helper.wrapEvent(testBody, testOtherUserId));

        expect(resultOfAttempt).to.deep.equal({ statusCode: 400 });
        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId);
        expect(updateSavingPoolStub).to.not.have.been.called;
    });

});

describe('*** UNIT TEST COLLECTIVE SAVING, FETCHES ***', () => {

    const mockAmountDict = (amount) => ({ amount: amount * 10000, unit: 'HUNDREDTH_CENT', currency: 'EUR' });
    const mockAmountSpread = (amount, prefix) => ({ [`${prefix}Amount`]: amount * 1000, [`${prefix}Unit`]: 'HUNDREDTH_CENT', [`${prefix}Currency`]: 'EUR' });

    const testEvent = (path, systemWideUserId, queryStringParameters) => ({
        requestContext: {
            authorizer: { systemWideUserId }
        },
        httpMethod: 'GET',
        pathParameters: {
            proxy: path
        },
        queryStringParameters   
    })

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
        ]

        const expectedPoolsToConsumer = [
            { savingPoolId: 'pool-1', poolName: 'Pool 1', target: mockAmountDict(100), current: mockAmountDict(20), creationTimeMillis: testCreatedMoment1.valueOf() },
            { savingPoolId: 'pool-2', poolName: 'Pool 2', target: mockAmountDict(30), current: mockAmountDict(35), creationTimeMillis: testCreatedMoment2.valueOf() }
        ];

        listSavingPoolsStub.resolves(mockPoolsFromPersistence);
        calculatePoolBalancesStub.resolves(mockBalancesFromPersistence);
        
        const resultOfFetch = await handler.readSavingsPool(testEvent('list', testUserId));
        const resultBody = helper.standardOkayChecks(resultOfFetch);
        expect(resultBody).to.deep.equal({ currentSavingPools: expectedPoolsToConsumer });

        expect(listSavingPoolsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

    it('Unit test getting a saving pot details', async () => {
        const testPoolId = uuid();

        const mockCreationTime = moment().subtract(2, 'weeks');
        const mockSaveTimes = [moment().subtract(3, 'days'), moment().subtract(2, 'weeks'), moment().subtract(1, 'days')]
        const mockSaveIds = [uuid(), uuid(), uuid()];

        const mockPoolFromPersistence = {
            savingPoolId: 'pool-id',
            creationTime: mockCreationTime,
            creatingUserId: 'some-other-user',
            ...mockAmountSpread(100, 'target'),
            ...mockAmountSpread(20, 'current'),
            participatingUsers: [{ userId: 'some-other-user' }, { userId: 'some-user-2', relationshipId: 'rel-1' }, { userId: 'some-user-3', relationshipId: 'rel-2' }],
            transactionRecord: [
                { transactionId: mockSaveIds[0], ownerUserId: 'some-user-2', ...mockAmountDict(5), creationTime: mockSaveTimes[0] },
                { transactionId: mockSaveIds[1], ownerUserId: 'some-other-user', ...mockAmountDict(5), creationTime: mockSaveTimes[1] },
                { transactionId: mockSaveIds[2], ownerUserId: testUserId, ...mockAmountDict(10), creationTime: mockSaveTimes[2] },
            ]
        };

        const mockProfiles = {
            'some-other-user': { personalName: 'Another', familyName: 'Person' },
            'some-user-2': { personalName: 'Thisone', familyName: 'That' },
            'some-user-3': { personalName: 'Oneorother', familyName: 'Here' }
        };

        const expectedResult = {
            savingPoolId: 'pool-id',
            creationTimeMillis: mockCreationTime.valueOf(),
            creatingUser: { personalName: 'Another', familyName: 'Person' },
            target: mockAmountDict(100),
            current: mockAmountDict(20),
            participatingUsers: Object.values(mockProfiles),
            transactionRecord: [
                { transactionId: mockSaveIds[0], saveBySelf: false, saverName: 'Thisone That', saveAmount: mockAmountDict(5), creationTimeMillis: mockSaveTimes[0].valueOf() },
                { transactionId: mockSaveIds[1], saveBySelf: false, saverName: 'Another person', saveAmount: mockAmountDict(5), creationTimeMillis: mockSaveTimes[1].valueOf() },
                { transactionId: mockSaveIds[2], saveBySelf: true, saveAmount: mockAmountDict(10), creationTimeMillis: mockSaveTimes[2].valueOf() }
            ]
        }

        fetchSavingPoolStub.resolves(mockPoolFromPersistence);

        const resultOfFetch = await handler.readSavingsPool(testEvent('fetch', testUserId, { savingPoolId: testPoolId }));
        const resultBody = helper.standardOkayChecks(resultOfFetch);
        expect(resultBody).to.deep.equal(expectedResult);

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly('pool-id', true); // flag says want full details
        expect(fetchProfileStub).to.have.been.calledThrice;
        expect(fetchProfileStub).to.have.been.calledWith('some-other-user');
        expect(fetchProfileStub).to.have.been.calledWith('some-user-2');
        expect(fetchProfileStub).to.have.been.calledWith('some-user-3');
    });

});
