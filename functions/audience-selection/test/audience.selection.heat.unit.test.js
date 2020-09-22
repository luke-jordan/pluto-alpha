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

describe('*** TEST HEAT POINT AND LEVEL SELECTION ***', () => {

    beforeEach(() => executeConditionsStub.reset());

    // similar to friends, uses the sub-query to deal with fact that heat is user-level property (i.e., aggregates over user's accounts)
    it('Handles heat points', async () => {
        
        const pointSubQuery = `(select greatest(prior_period_points, current_period_points) from ` +
            `transaction_data.user_heat_state where system_wide_user_id = owner_user_id)`;
        
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: [
                { op: 'and', children: [
                    { prop: 'savingHeatPoints', op: 'greater_than', value: 200, type: 'match' }
                ]}
            ]
        };

        const expectedSelection = {
            table: 'account_data.core_account_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { op: 'greater_than', prop: pointSubQuery, value: 200, valueType: 'int' },
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

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 5 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 5 });

        expect(executeConditionsStub).to.have.been.calledOnce;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams, expectedSelection);
    });

    it('Handles heat levels', async () => {
        const levelSubQuery = `(select current_level_id from ` +
            `transaction_data.user_heat_state where system_wide_user_id = owner_user_id)`;
        
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: [
                { op: 'and', children: [
                    { prop: 'savingHeatLevel', op: 'is', value: 'purple-level-id', type: 'match' }
                ]}
            ]
        };

        const expectedSelection = {
            table: 'account_data.core_account_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { op: 'is', prop: levelSubQuery, value: 'purple-level-id', valueType: 'int' },
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

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 20 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 20 });

        expect(executeConditionsStub).to.have.been.calledOnce;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams, expectedSelection);
    });

});
