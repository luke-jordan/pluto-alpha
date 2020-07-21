'use strict';

// const logger = require('debug')('jupiter:audience-selection:test');

const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const helper = require('./test.helper');

const executeConditionsStub = sinon.stub();
const upsertAudienceAccountsStub = sinon.stub();
const fetchAudienceStub = sinon.stub();
const deactivateAudienceAccountsStub = sinon.stub();

const audienceHandler = proxyquire('../audience-handler', {
    './persistence': {
        'executeColumnConditions': executeConditionsStub,
        'upsertAudienceAccounts': upsertAudienceAccountsStub,
        'fetchAudience': fetchAudienceStub,
        'deactivateAudienceAccounts': deactivateAudienceAccountsStub,
        '@noCallThru': true
    }
});

const mockUserId = 'some-user';
const mockClientId = 'test-client-id';

describe('Audience selection - date based properties', () => {

    beforeEach(() => executeConditionsStub.reset());

    it('Should handle account opened date well, if simple range', async () => {
        const testOpenTime = moment().subtract(30, 'days');

        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { op: 'and', children: [
                    { prop: 'accountOpenTime', op: 'greater_than', value: String(testOpenTime.valueOf()) }
                ]}
            ]
        };

        const expectedSelection = {
            creatingUserId: mockUserId,
            table: 'account_data.core_account_ledger',
            conditions: [
                { op: 'and', children: [
                    { op: 'greater_than', prop: 'creation_time', value: testOpenTime.format() },
                    { op: 'is', prop: 'responsible_client_id', value: mockClientId }
                ]
            }]
        };

        const expectedPersistenceParams = {
            audienceType: 'PRIMARY',
            clientId: 'test-client-id',
            creatingUserId: mockUserId,
            isDynamic: false,
            propertyConditions: mockSelectionJSON.conditions
        };

        
        const mockAudienceId = 'created-audience-id';
        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 10000 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 10000 });

        expect(executeConditionsStub).to.have.been.calledOnceWithExactly(expectedSelection, true, expectedPersistenceParams);
    });

    it('Should convert account opened date to specific day interval', async () => {
        const testOpenTime = moment().subtract(30, 'days');

        const testOpenTimeStart = testOpenTime.clone().startOf('day'); // remember these mutate hence clone
        const testOpenTimeEnd = testOpenTime.clone().endOf('day');

        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { op: 'and', children: [
                    { prop: 'accountOpenTime', op: 'is', value: testOpenTime.valueOf() }
                ]}
            ]
        };

        // slightly inelegant nesting here, but tolerable for now
        const expectedDateInterval = {
            op: 'and', children: [
                { op: 'greater_than_or_equal_to', prop: 'creation_time', value: testOpenTimeStart.format() },
                { op: 'less_than_or_equal_to', prop: 'creation_time', value: testOpenTimeEnd.format() }
            ]
        };

        const expectedClientCondition = { op: 'is', prop: 'responsible_client_id', value: mockClientId };

        const expectedSelection = {
            creatingUserId: mockUserId,
            table: 'account_data.core_account_ledger',
            conditions: [
                { op: 'and', children: [
                    expectedDateInterval,
                    expectedClientCondition 
                ]
            }]
        };

        const expectedPersistenceParams = {
            audienceType: 'PRIMARY',
            clientId: 'test-client-id',
            creatingUserId: mockUserId,
            isDynamic: false,
            propertyConditions: mockSelectionJSON.conditions
        };

        const mockAudienceId = 'created-audience-id';
        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 10000 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 10000 });

        expect(executeConditionsStub).to.have.been.calledOnceWithExactly(expectedSelection, true, expectedPersistenceParams);
    });

    it('Should convert account open X days ago to specific date', async () => {
        const mockInbound = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: [
                { prop: 'accountOpenDays', op: 'is', value: 5, type: 'match' }
            ]
        };

        const refMoment = moment().subtract(5, 'days'); // _just_ in case run the test over midnight
        const expectedStart = refMoment.clone().startOf('day').format();
        const expectedEnd = refMoment.clone().endOf('day').format();

        const expectedSelection = {
            creatingUserId: mockUserId,
            table: 'account_data.core_account_ledger',
            conditions: [
                { op: 'and', children: [
                    { op: 'greater_than_or_equal_to', prop: 'creation_time', value: expectedStart },
                    { op: 'less_than_or_equal_to', prop: 'creation_time', value: expectedEnd },
                    { op: 'is', prop: 'responsible_client_id', value: mockClientId }
                ]}
            ]
        };

        executeConditionsStub.resolves({ audienceId: 'audience-id', audienceCount: 500 });

        const request = helper.wrapAuthorizedRequest(mockInbound, mockUserId);
        const result = await audienceHandler.handleInboundRequest(request);
        helper.standardOkayChecks(result, { audienceId: 'audience-id', audienceCount: 500 });

        const expectedPersistenceParams = {
            audienceType: 'PRIMARY',
            clientId: 'test-client-id',
            creatingUserId: mockUserId,
            isDynamic: true,
            propertyConditions: mockInbound.conditions
        };

        helper.itemizedSelectionCheck(executeConditionsStub, expectedPersistenceParams, expectedSelection);
    });

    it('Should properly refresh account open X days ago, and convert ranges, including flip', async () => {
        const mockAudienceId = 'some-audience-id';

        const testPropertyConditions = [
            { op: 'and', children: [
                { prop: 'accountOpenDays', op: 'less_than', value: 5, type: 'match' },
                { prop: 'accountOpenDays', op: 'greater_than', value: 3, type: 'match' }
            ]}
        ];
        
        const mockAudience = {
            clientId: mockClientId,
            creationTime: moment().subtract(2, 'months').format(),
            creatingUserId: mockUserId,
            isDynamic: true,
            propertyConditions: { conditions: testPropertyConditions }
        };
        
        const invocation = {
            operation: 'refresh',
            params: { audienceId: mockAudienceId }
        };

        const testAudienceAccountIdsList = ['test-account-1', 'test-account-2'];

        fetchAudienceStub.withArgs(mockAudienceId).resolves(mockAudience);
        deactivateAudienceAccountsStub.withArgs(mockAudienceId).resolves(['test-account-1']);

        // effect of with args is covered by expectations below, which provided better paths for fixing
        executeConditionsStub.resolves(testAudienceAccountIdsList);
        upsertAudienceAccountsStub.resolves(testAudienceAccountIdsList);

        const wrappedResult = await audienceHandler.handleInboundRequest(invocation);
        helper.standardOkayChecks(wrappedResult, { result: `Refreshed audience successfully, audience currently has 2 members` });
        
        // note that "greater than 5 days old" actually means "less than the timestamp 3 days ago"
        const refMoment = moment();
        const expectedStart = refMoment.clone().subtract(5, 'days').startOf('day').format();
        // the following makes code cleanest, though may be a little  counter-intuitive (means "less than X days" = "less than or equal to X days")
        const expectedEnd = refMoment.clone().subtract(3, 'days').startOf('day').format(); 

        const expectedSelection = {
            creatingUserId: mockUserId,
            table: 'account_data.core_account_ledger',
            conditions: [
                { op: 'and', children: [
                    { op: 'greater_than_or_equal_to', prop: 'creation_time', value: expectedStart },
                    { op: 'less_than_or_equal_to', prop: 'creation_time', value: expectedEnd },
                    { op: 'is', prop: 'responsible_client_id', value: mockClientId }
                ]}
            ]
        };
        
        expect(executeConditionsStub).to.have.been.calledOnce;
        // expect(executeConditionsStub).to.have.been.calledOnceWithExactly(expectedSelection, false); // as upsert does the persisting  
        
        const executedArgs = executeConditionsStub.getCall(0).args;
        expect(executedArgs[0]).to.deep.equal(expectedSelection);
        expect(executedArgs[1]).to.be.false;
    });

    it('Should make capitalization day interval work time', async () => {
        const testCapitalizationTime = moment();

        const testOpenTimeStart = testCapitalizationTime.clone().startOf('day'); // remember these mutate hence clone
        const testOpenTimeEnd = testCapitalizationTime.clone().endOf('day');

        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { prop: 'lastCapitalization', op: 'is', value: testCapitalizationTime.valueOf() }
            ]
        };

        // slightly inelegant nesting here, but tolerable for now
        const expectedDateInterval = {
            op: 'and', children: [
                { op: 'greater_than_or_equal_to', prop: 'creation_time', value: testOpenTimeStart.format() },
                { op: 'less_than_or_equal_to', prop: 'creation_time', value: testOpenTimeEnd.format() }
            ]
        };

        const expectedClientCondition = { op: 'is', prop: 'client_id', value: mockClientId };

        const expectedSelection = {
            creatingUserId: mockUserId,
            table: 'transaction_data.core_transaction_ledger',
            conditions: [
                { op: 'and', children: [
                    expectedDateInterval,
                    { op: 'is', prop: 'settlement_status', value: 'SETTLED' },
                    { op: 'is', prop: 'transaction_type', value: 'CAPITALIZATION' },
                    expectedClientCondition
                ]
            }]
        };

        const expectedPersistenceParams = {
            audienceType: 'PRIMARY',
            clientId: 'test-client-id',
            creatingUserId: mockUserId,
            isDynamic: false,
            propertyConditions: mockSelectionJSON.conditions
        };

        const mockAudienceId = 'created-audience-id';
        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 10000 });

        const authorizedRequest = helper.wrapAuthorizedRequest(mockSelectionJSON, mockUserId);
        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        helper.standardOkayChecks(wrappedResult, { audienceId: mockAudienceId, audienceCount: 10000 });

        expect(executeConditionsStub).to.have.been.calledOnceWithExactly(expectedSelection, true, expectedPersistenceParams);
    });

});
