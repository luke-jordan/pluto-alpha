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

    it('Handles conversion into boost redeemed', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { prop: 'boostRedeemed', op: 'is', value: 'this-boost-here', type: 'match' }
            ]
        };

        const expectedSelection = {
            table: 'boost_data.boost_account_status',
            creatingUserId: mockUserId,
            conditions: [{ op: 'and', children: [
                { prop: 'boost_id', op: 'is', value: 'this-boost-here' },
                { prop: 'boost_status', op: 'is', value: 'REDEEMED' }
            ]}]
        };

        const mockAudienceId = 'created-audience-id';

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 20 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 20 });

        expect(executeConditionsStub).to.have.been.calledOnce;

        const persParams = expectedPersParams(mockSelectionJSON.conditions, 'PRIMARY', false);
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

    // this one is quite tricky because we have to 'cross' it with 1+ transactions and then invert, so that we end up selecting
    // people who have 0 offered boosts in the period (good old selecting negative problem)
    it('Handles number of boosts in period', async () => {
        const startTime = moment().subtract(1, 'week');
        const endTime = moment();

        const mockInbound = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [{ op: 'and', children: [
                { prop: 'boostCount', op: 'less_than', value: 2, startTime: startTime.valueOf(), endTime: endTime.valueOf(), type: 'match' }
            ]}]
        };

        // leaving this here for if we come back and end up implementing a proper inverted-intermediate logic
        // NB : note the operation has flipped from less than to greater than, because we are going to invert this audience
        // const expectedBoostCountSelection = {
        //     table: 'boost_data.boost_account_status',
        //     creatingUserId: mockUserId,
        //     conditions: [
        //         { op: 'and', children: [
        //             { op: 'not', prop: 'boost_status', value: 'CREATED' }, // at present, exclude not-offered event driven or ML
        //             { op: 'greater_than', prop: 'creation_time', value: startTime.format() },
        //             { op: 'less_than', prop: 'creation_time', value: endTime.format() }
        //         ]}
        //     ],
        //     groupBy: [
        //         'account_id'
        //     ],
        //     postConditions: [
        //         { op: 'greater_than_or_equal_to', prop: 'count(boost_id)', value: 2, valueType: 'int' }
        //     ]
        // };

        // executeConditionsStub.onFirstCall().resolves({ audienceId: 'inverted-audience-id', audienceCount: 25 });

        // const intermQuery = `select account_id from audience_data.audience_account_join where audience_id = 'inverted-audience-id' and active = true`;
        // // then in here we are going to do an exclusion on the aggregate
        // const expectedFlippedSelection = {
        //     table: 'transaction_data.core_transaction_ledger',
        //     creatingUserId: mockUserId,
        //     conditions: [
        //         { op: 'and', children: [
        //             { prop: 'account_id', op: 'not_in', value: intermQuery },
        //             { prop: 'client_id', op: 'is', value: mockClientId }
        //         ]}
        //     ]
        // };

        // this is a hacky way to do this but is simplest at present, without implementing whole intermediate-flip logic (come back to)
        // note : avoid this becoming a pattern, or will lead to a lot of nasty fragile subqueries; if need again, implement intermediate-flip
        // note : still need to flip the operator because this will enter under 'not in'
        const expectedSubQuery = `select account_id from boost_data.boost_account_status where boost_status != 'CREATED' and ` + 
            `creation_time between '${startTime.format()}' and '${endTime.format()}' group by account_id having count(boost_id) >= 2`;
        
        const expectedBoostCountSelection = {
            table: 'transaction_data.core_transaction_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'account_id', op: 'not_in', value: expectedSubQuery },
                    { prop: 'client_id', op: 'is', value: mockClientId }
                ]}
            ]
        };

        executeConditionsStub.resolves({ audienceId: 'final-audience', audienceCount: 100 });

        const request = helper.wrapAuthorizedRequest(mockInbound, mockUserId);
        const result = await audienceHandler.handleInboundRequest(request);
        
        helper.standardOkayChecks(result, { audienceId: 'final-audience', audienceCount: 100 });
        
        const { conditions } = mockInbound;
        expect(executeConditionsStub).to.have.been.calledOnce;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersParams(conditions, 'PRIMARY'), expectedBoostCountSelection);
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
