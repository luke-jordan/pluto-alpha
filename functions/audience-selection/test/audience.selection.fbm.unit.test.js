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
            isDynamic: false,
            conditions: [
                { prop: 'boostNotRedeemed', op: 'is', value: 'this-boost-here', type: 'match' }
            ]
        };

        const expectedSelection = {
            table: 'boost_data.boost_account_status',
            creatingUserId: '',
            conditions: [{ op: 'and', children: [
                { 'prop': 'boost_id', op: 'is', value: 'this-boost-here' },
                { 'prop': 'boost_status', op: 'in', value: ['CREATED', 'OFFERED', 'UNLOCKED'] }
            ]}]
        };

    });


    // going to be a bit more complex because of the issues with the friend counting, so come back to it
    // it('Handles conversion into friend numbers', async () => {
    //     const mockSelectionJSON = {
    //         clientId: mockClientId,
    //         isDynamic: false,
    //         conditions: [
    //             { prop: 'numberFriends', op: 'greater_than', value: 2, type: 'match' }
    //         ]
    //     };

    //     const expectedIntermediateSelection = {
    //         table: 'friend_data.core_friend_relationship',
    //         creatingUserId: mockUserId,
    //         conditions: [
    //             { op: 'and', children: [
    //                 { prop: 'settlement_status', op: 'in', value: ['SETTLED', 'ACCRUED'] },
    //                 { prop: 'transaction_type', op: 'in', value: ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'] },
    //                 { prop: 'client_id', op: 'is', value: 'test-client-id' }
    //             ]
    //         }],
    //         groupBy: ['account_id', 'unit'],
    //         postConditions: [
    //             { op: 'less_than', prop: summationProperty, value: 20 * 100 * 100, valueType: 'int' }
    //         ]

    //     }
    // });

});