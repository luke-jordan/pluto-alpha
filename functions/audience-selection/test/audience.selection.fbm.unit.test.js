'use strict';

const moment = require('moment');

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

    const expectedPersParams = (conditions, audienceType, isDynamic = false) => ({
        clientId: mockClientId,
        creatingUserId: mockUserId,
        isDynamic,
        propertyConditions: conditions,
        audienceType
    });

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

        const mockAudienceId = 'created-audience-id';

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 20 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 20 });

        expect(executeConditionsStub).to.have.been.calledOnce;

        const persParams = expectedPersParams(mockSelectionJSON.conditions, 'PRIMARY', true);
        helper.itemizedSelectionCheck(executeConditionsStub, persParams, expectedSelection);
    });

    it('Handles exclusion of a boost', async () => {
        const mockInbound = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [{ op: 'and', children: [
                { prop: 'boostOffered', op: 'exclude', value: 'this-boost-here', type: 'aggregate' } 
            ]}]
        };

        const expectedInitialSelection = {
            table: 'boost_data.boost_account_status',
            creatingUserId: mockUserId,
            conditions: [{ op: 'and', children: [
                { prop: 'boost_id', op: 'is', value: 'this-boost-here' },
                { prop: 'boost_status', op: 'not', value: 'CREATED' }
            ]}]
        };

        const interimAudienceQuery = `select account_id from audience_data.audience_account_join where audience_id = 'created-audience-1' and active = true`;
        const expectedFinalSelection = {
            table: 'transaction_data.core_transaction_ledger', // as just our standard (but may reconsider at some point for zero-transaction users if they are targeted by this)
            creatingUserId: mockUserId,
            conditions: [{ op: 'and', children: [
                { prop: 'account_id', op: 'not_in', value: interimAudienceQuery },
                { prop: 'client_id', op: 'is', value: mockClientId }
            ]}]
        };

        executeConditionsStub.onFirstCall().resolves({ audienceId: 'created-audience-1', audienceCount: 200 });
        executeConditionsStub.onSecondCall().resolves({ audienceId: 'final-audience', audienceCount: 300 });

        const request = helper.wrapAuthorizedRequest(mockInbound, mockUserId);
        const result = await audienceHandler.handleInboundRequest(request);

        helper.standardOkayChecks(result, { audienceId: 'final-audience', audienceCount: 300 });
        
        const { conditions } = mockInbound;
        expect(executeConditionsStub).to.have.been.calledTwice;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersParams(conditions, 'INTERMEDIATE'), expectedInitialSelection);
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersParams(conditions, 'PRIMARY'), expectedFinalSelection, 1);
    });

    it('Handles number of boosts in period', async () => {
        const startTime = moment().subtract(1, 'week');
        const endTime = moment();

        const mockInbound = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [{ op: 'and', children: [
                { prop: 'boostCount', op: 'less_than', value: 2, startTime: startTime.valueOf(), endTime: endTime.valueOf(), type: 'aggregate' }
            ]}]
        };

        // note : with multi-clients, may need ot add a sub-clause here to select boosts only with that cleitn
        const expectedBoostCountSelection = {
            table: 'boost_data.boost_account_status',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { op: 'not', prop: 'boost_account_status', value: 'CREATED' }, // at present, exclude not-offered event driven or ML
                    { op: 'greater_than', prop: 'creation_time', value: startTime.format() },
                    { op: 'less_than', prop: 'creation_time', value: endTime.format() }
                ]}
            ],
            groupBy: [
                'account_id'
            ],
            postConditions: [
                { op: 'less_than', prop: 'count(boost_id)', value: 2, valueType: 'int' }
            ]
        };

        executeConditionsStub.onFirstCall().resolves({ audienceId: 'audience-id', audienceCount: 25 });
        executeConditionsStub.onSecondCall().resolves({ audienceId: 'final-audience', audienceCount: 25 });

        const request = helper.wrapAuthorizedRequest(mockInbound, mockUserId);
        const result = await audienceHandler.handleInboundRequest(request);
        
        helper.standardOkayChecks(result, { audienceId: 'final-audience', audienceCount: 25 });
        
        const { conditions } = mockInbound;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersParams(conditions, 'INTERMEDIATE'), expectedBoostCountSelection);
        // final primary call covered a lot elsewhere (and handily places a client restriction on)
    });

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
