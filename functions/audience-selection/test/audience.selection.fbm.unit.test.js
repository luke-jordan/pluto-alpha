'use strict';

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const helper = require('./test.helper');

const executeConditionsStub = sinon.stub();
const audienceHandler = proxyquire('../audience-handler', {
    './persistence': {
        'executeColumnConditions': executeConditionsStub,
        '@noCallThru': true
    }
});

const mockUserId = 'some-user';
const mockClientId = 'test-client-id';

describe('*** TEST BOOST AND FRIEND SELECTION ***', () => {

    beforeEach(() => executeConditionsStub.reset());

    it('Handles conversion into boost offered but not redeemed', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: [
                { prop: 'boostNotRedeemed', op: 'is', value: 'this-boost-here', type: 'match' }
            ]
        };

        const expectedSelection = {
            table: 'boost_data.boost_account_status',
            creatingUserId: mockUserId,
            conditions: [{ op: 'and', children: [
                { prop: 'boost_id', op: 'is', value: 'this-boost-here' },
                { prop: 'boost_status', op: 'in', value: ['CREATED', 'OFFERED', 'UNLOCKED'] }
            ]}]
        };

        const expectedPersistenceParams = {
            clientId: 'test-client-id',
            creatingUserId: mockUserId,
            isDynamic: true,
            propertyConditions: mockSelectionJSON.conditions,
            audienceType: 'PRIMARY'
        };

        const mockAudienceId = 'created-audience-id';

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 20 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 20 });

        expect(executeConditionsStub).to.have.been.calledOnce;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams, expectedSelection);
    });

    // it('Combines not in boost with number of saves', async () => {
        
    // });

    // it('Combines boost account and ')


    // going to be a bit more complex because of the issues with the friend counting, so come back to it
    it('Handles conversion into friend numbers', async () => {
        const countSubQuery = `(select count(*) from friend_data.core_friend_relationship where (initiated_user_id = owner_user_id or accepted_user_id = owner_user_id) and ` +
            `relationship_status = 'ACTIVE')`;
        
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: [
                { op: 'and', children: [
                    { prop: 'numberFriends', op: 'greater_than', value: 2, type: 'match' }
                ]}
            ]
        };

        const expectedSelection = {
            table: 'account_data.core_account_ledger', // see note in condition-converter std properties list
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { op: 'greater_than', prop: countSubQuery, value: 2, valueType: 'int' },
                    { op: 'is', prop: 'responsible_client_id', value: 'test-client-id' }
                ]}
            ]
        };

        const expectedPersistenceParams = {
            clientId: 'test-client-id',
            creatingUserId: mockUserId,
            isDynamic: true,
            propertyConditions: mockSelectionJSON.conditions,
            audienceType: 'PRIMARY'
        };

        const mockAudienceId = 'created-audience-id';

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 12 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 12 });

        expect(executeConditionsStub).to.have.been.calledOnce;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams, expectedSelection);
    });

});
