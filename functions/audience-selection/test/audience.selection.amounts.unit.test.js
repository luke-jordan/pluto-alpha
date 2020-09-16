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

describe('*** TEST BALANCE SELECTION ***', () => {

    beforeEach(() => executeConditionsStub.reset());

    const summationProperty = `SUM(
        CASE
            WHEN unit = 'WHOLE_CENT' THEN
                amount * 100
            WHEN unit = 'WHOLE_CURRENCY' THEN
                amount * 10000
        ELSE
            amount
        END
    )`.replace(/\s\s+/g, ' ');

    const expectedPersistenceParams = (audienceType, conditions) => ({
        audienceType,
        clientId: 'test-client-id',
        creatingUserId: mockUserId,
        isDynamic: false,
        propertyConditions: conditions
    });

    it('Handles conversion into balance, with units, properly', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { prop: 'currentBalance', op: 'less_than', value: '20', type: 'aggregate' }
            ]
        };

        const expectedInitialSelection = {
            table: 'transaction_data.core_transaction_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'settlement_status', op: 'in', value: ['SETTLED', 'ACCRUED', 'LOCKED'] },
                    { prop: 'transaction_type', op: 'in', value: ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION', 'BOOST_REVOCATION'] },
                    { prop: 'client_id', op: 'is', value: 'test-client-id' }
                ]
            }],
            groupBy: ['account_id'],
            postConditions: [
                { op: 'less_than', prop: summationProperty, value: 20 * 100 * 100, valueType: 'int' }
            ]
        };

        const expectedWrapperSelection = {
            table: 'transaction_data.core_transaction_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'client_id', op: 'is', value: 'test-client-id' },
                    { prop: 'account_id', op: 'in', value: `select account_id from audience_data.audience_account_join where audience_id = 'created-audience-id' and active = true`}
                ]}
            ]
        };
        
        const mockAudienceId = 'created-audience-id';
        executeConditionsStub.onFirstCall().resolves({ audienceId: mockAudienceId, audienceCount: 145 });
        executeConditionsStub.onSecondCall().resolves({ audienceId: 'primary-audience', audienceCount: 145 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: 'primary-audience', audienceCount: 145 });

        const { conditions } = mockSelectionJSON;

        expect(executeConditionsStub).to.have.been.calledTwice;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('INTERMEDIATE', conditions), expectedInitialSelection);
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('PRIMARY', conditions), expectedWrapperSelection, 1);
    });

    it('Handles saving this month', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { op: 'and', children: [
                    { prop: 'savedThisMonth', op: 'greater_than', value: '20', type: 'aggregate' },
                    { prop: 'savedThisMonth', op: 'less_than', value: '50', type: 'aggregate' }
                ]}
            ]
        };

        const expectedAmountSelection = (op, value) => ({
            table: 'transaction_data.core_transaction_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'settlement_status', op: 'in', value: ['SETTLED'] },
                    { prop: 'transaction_type', op: 'in', value: ['USER_SAVING_EVENT'] },
                    { prop: 'creation_time', op: 'greater_than', value: moment().startOf('month').format() },
                    { prop: 'client_id', op: 'is', value: 'test-client-id' }
                ]
            }],
            groupBy: ['account_id'],
            postConditions: [
                { op, prop: summationProperty, value, valueType: 'int' }
            ]
        });

        const expectedWrapperSelection = {
            table: 'transaction_data.core_transaction_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'account_id', op: 'in', value: `select account_id from audience_data.audience_account_join where audience_id = 'intermediate-audience-1' and active = true`},
                    { prop: 'account_id', op: 'in', value: `select account_id from audience_data.audience_account_join where audience_id = 'intermediate-audience-2' and active = true`},
                    { prop: 'client_id', op: 'is', value: 'test-client-id' }
                ]}
            ]
        };
        
        executeConditionsStub.onFirstCall().resolves({ audienceId: 'intermediate-audience-1', audienceCount: 145 });
        executeConditionsStub.onSecondCall().resolves({ audienceId: 'intermediate-audience-2', audienceCount: 125 });
        executeConditionsStub.onThirdCall().resolves({ audienceId: 'primary-audience', audienceCount: 105 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: 'primary-audience', audienceCount: 105 });

        expect(executeConditionsStub).to.have.been.calledThrice;

        const expectedFirstSelection = expectedAmountSelection('greater_than', 20 * 100 * 100);
        const expectedSecondSelection = expectedAmountSelection('less_than', 50 * 100 * 100);

        const { conditions } = mockSelectionJSON;
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('INTERMEDIATE', conditions), expectedFirstSelection, 0);
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('INTERMEDIATE', conditions), expectedSecondSelection, 1);
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('PRIMARY', conditions), expectedWrapperSelection, 2);
    });

    it('Combines number of saves and account open date', async () => {
        const testMoment = moment();
        const testCondition = {
            clientId: 'test-client-id',
            isDynamic: false,
            conditions: [
                { op: 'and', children: [
                    { op: 'greater_than', value: '10', prop: 'saveCount', type: 'aggregate' },
                    { op: 'less_than', value: testMoment.valueOf(), prop: 'accountOpenTime', type: 'match' }
                    ]
                }
            ]
        };

        executeConditionsStub.onFirstCall().resolves({ audienceId: 'intermediate-audience-1', audienceCount: 145 });
        executeConditionsStub.onSecondCall().resolves({ audienceId: 'intermediate-audience-2', audienceCount: 125 });
        executeConditionsStub.onThirdCall().resolves({ audienceId: 'primary-audience', audienceCount: 20 });

        const authorizedRequest = helper.wrapAuthorizedRequest(testCondition, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);

        helper.standardOkayChecks(wrappedResult, { audienceId: 'primary-audience', audienceCount: 20 });

        const { conditions } = testCondition;
        const expectedAccountCondition = {
            table: 'account_data.core_account_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'responsible_client_id', op: 'is', value: 'test-client-id' },
                    { prop: 'creation_time', op: 'less_than', value: testMoment.format() }
                ]}
            ]
        };
        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('INTERMEDIATE', conditions), expectedAccountCondition, 1);

        const expectedWrapperSelection = {
            table: 'transaction_data.core_transaction_ledger',
            creatingUserId: mockUserId,
            conditions: [
                { op: 'and', children: [
                    { prop: 'account_id', op: 'in', value: `select account_id from audience_data.audience_account_join where audience_id = 'intermediate-audience-1' and active = true`},
                    { prop: 'account_id', op: 'in', value: `select account_id from audience_data.audience_account_join where audience_id = 'intermediate-audience-2' and active = true`},
                    { prop: 'client_id', op: 'is', value: 'test-client-id' }
                ]}
            ]
        };

        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams('PRIMARY', conditions), expectedWrapperSelection, 2);
    });

});
