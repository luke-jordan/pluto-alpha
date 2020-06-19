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
const audienceHandler = proxyquire('../audience-handler', {
    './persistence': {
        'executeColumnConditions': executeConditionsStub,
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

        // handy for debugging, if necessary
        // const passedSelection = executeConditionsStub.getCall(0).args[0];
        // logger('Passed selection: ', JSON.stringify(passedSelection.conditions, null, 2));
        // logger('Expected: ', JSON.stringify(expectedSelection.conditions, null, 2))
        // expect(passedSelection).to.deep.equal(expectedSelection);

        expect(executeConditionsStub).to.have.been.calledOnceWithExactly(expectedSelection, true, expectedPersistenceParams);
    });

});
