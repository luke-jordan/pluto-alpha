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

const fetchSavingPoolStub = sinon.stub();

const handler = proxyquire('../friend-saving-handler', {

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
            targetAmount: 10000,
            targetUnit: 'WOHLE_CURRENCY',
            targetCurrency: 'ZAR',
            participatingUsers: mockUsers
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
        const mockUsers = ['user-1', 'user-2'];

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
        const mockUser = ['user-N'];

        const testBody = {
            savingPoolId: testPoolId,
            friendshipsToAdd: mockFriendship
        };

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });
        extractFriendIdsStub.resolves(mockUser);
        updateSavingPoolStub.resolves({ updatedTime: moment() });

        const resultOfUpdate = await handler.updateSavingPool(helper.wrapEvent(testBody), testUserId);

        const resultBody = helper.standardOkayChecks(resultOfUpdate);
        expect(resultBody).to.deep.equal({ updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId);
        expect(extractFriendIdsStub).to.have.been.calledOnceWithExactly(mockFriendship);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, { friendshipsToAdd: mockFriendship });
    });

    it('Unit test renaming a saving pot', async () => {
        const testPoolId = uuid();

        const testBody = {
            savingPoolId: testPoolId,
            name: 'Trip to Taipei'
        };

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });
        updateSavingPoolStub.resolves({ updatedTime: moment() });

        const resultOfAttempt = await handler.updateSavingPool(helper.wrapEvent(testBody, testUserId));

        const resultBody = helper.standardOkayChecks(resultOfAttempt);
        expect(resultBody).to.deep.equal({ updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId);
        expect(updateSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId, { name: 'Trip to Taipei' });
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

        const mockUpdatedTime = moment();

        fetchSavingPoolStub.resolves({ creatingUserId: testUserId });
        updateSavingPoolStub.resolves({ updatedTime: mockUpdatedTime });

        const resultOfAttempt = await handler.updateSavingPool(helper.wrapEvent(testBody, testUserId));
        const resultBody = helper.standardOkayChecks(resultOfAttempt);

        expect(resultBody).to.deep.equal({ updatedTime: mockUpdatedTime.valueOf() });

        expect(fetchSavingPoolStub).to.have.been.calledOnceWithExactly(testPoolId);

        const expectedUpdateArg = { targetAmount: 15000, targetUnit: 'WHOLE_CURRENCY', targetCurrency: 'ZAR' };
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

    it('Unit test calculating a saving pot amount', async () => {

    });

    it('Unit test getting a saving pot details', async () => {

    });
});
