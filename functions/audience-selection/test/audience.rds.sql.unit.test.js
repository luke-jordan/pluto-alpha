'use strict';

const uuid = require('uuid/v4');

const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

// just to prevent call throughs
const proxyquire = require('proxyquire');
const audienceSelection = proxyquire('../persistence.js', {
    // 'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const rootJSON = {
    table: 'transactions'
};

describe('Core SQL query construction from spec JSON', () => {

    it(`should handle 'is' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' }
            ]
        });

        const expectedQuery = `select account_id from transactions where transaction_type='USER_SAVING_EVENT' group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'greater_than' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                    { 'op': 'greater_than', 'prop': 'creation_time', 'value': '2019-08-07' }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time>'2019-08-07' group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'greater_than_or_equal_to' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                    { 'op': 'greater_than_or_equal_to', 'prop': 'creation_time', 'value': '2019-08-07' }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time>='2019-08-07' group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'less_than' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                    { 'op': 'less_than', 'prop': 'creation_time', 'value': '2019-08-07' }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time<'2019-08-07' group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'less_than_or_equal_to' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                    { 'op': 'less_than_or_equal_to', 'prop': 'creation_time', 'value': '2019-08-07' }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time<='2019-08-07' group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle in operator, string version', async () => {
        const mockAccountId1 = uuid();
        const mockAccountId2 = uuid();

        // looks a bit weird but is used extensively in aggregate->match conversions, and more mundanely in selecting specific accounts
        // e.g., when they come from referrals (though note, array passing is also fine, and converted)
        const mockSelectionObject = { 
            table: 'account_data.core_account_ledger',
            columns: ['account_id'],
            conditions: [{
                'op': 'in', 'prop': 'account_id', 'value': `${mockAccountId1}, ${mockAccountId2}`
            }]
        };

        const expectedQuery = `select account_id from account_data.core_account_ledger where account_id in (${mockAccountId1}, ${mockAccountId2})`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionObject);
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle in operator, array version', async () => {
        // more standard version
        const mockSelectionObject = { 
            table: 'account_data.core_account_ledger',
            columns: ['account_id'],
            conditions: [{
                'op': 'in', 'prop': 'human_ref', 'value': ['humanref1', 'humanref2']
            }]
        };

        const expectedQuery = `select account_id from account_data.core_account_ledger where human_ref in ('humanref1', 'humanref2')`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionObject);
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle simple AND statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                 'op': 'and', 'children': [
                     { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                     { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle simple OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                'op': 'or', 'children': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                    { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }]
        });
        const expectedQuery = `select account_id from transactions where (transaction_type='USER_SAVING_EVENT' or settlement_status='SETTLED') group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle simple AND and OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                'op': 'or', 'children': [
                    { 'op': 'and', 'children': [
                        { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                        { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                    ]},
                    { 'op': 'is', 'prop': 'creation_time', 'value': '2019-01-27' }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27') group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });


    it('should be able to handle complex AND and OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                'op': 'or', 'children': [
                    { 'op': 'and', 'children': [
                        { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                        { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                    ]},
                    { 'op': 'and', 'children': [
                        { 'op': 'is', 'prop': 'creation_time', 'value': '2019-01-27' },
                        { 'op': 'is', 'prop': 'responsible_client_id', 'value': 1, 'valueType': 'int' }
                    ]}
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or (creation_time='2019-01-27' and responsible_client_id=1)) group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle more complex AND and OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'or', 'children': [
                        { 'op': 'and', 'children': [
                                { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                                { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                        ]},
                        { 'op': 'is', 'prop': 'creation_time', 'value': '2019-01-27' }
                    ]},
                    { 'op': 'is', 'prop': 'responsible_client_id', 'value': 1, 'valueType': 'int' }
                ]
            }]
        });
        const expectedQuery = `select account_id from transactions where (((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27') and responsible_client_id=1) group by account_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle random samples with conditions', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'sample': { random: 50 },
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                    { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }]
        });

        // note : random query sometimes ends up with both distinct and group by, which is theoretically inefficient, but alternative is 
        // to strip account_id from group by columns in random sample subquery assembly, which is full of traps, so we live with it
        // (and strong likelihood psql just skips one of the two steps with the other present, or it happens in a millisec)
        const expectedQuery = `select account_id from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')` +
            ` group by account_id order by random() limit ((select count(distinct(account_id)) from transactions` +
            ` where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')) * 0.5)`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle column filters', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'columns': ['account_id', 'creation_time'],
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                    { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }]
        });

        const expectedQuery = `select account_id, creation_time from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle groupBy filters', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'columns': ['responsible_client_id', 'creation_time'],
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                    { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }],
            'groupBy': ['responsible_client_id']
        });

        const expectedQuery = `select responsible_client_id, creation_time from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') group by responsible_client_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle column to count along with groupBy filters', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'columns': ['responsible_client_id'],
            'columnsToCount': ['account_id', 'owner_user_id'],
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                    { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }],
            'groupBy': ['responsible_client_id']
        });

        const expectedQuery = `select responsible_client_id, count(account_id), count(owner_user_id) from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') group by responsible_client_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle having filters along with column to count', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'columns': ['responsible_client_id'],
            'columnsToCount': ['account_id'],
            'groupBy': ['responsible_client_id'],
            'postConditions': [{ 'op': 'greater_than_or_equal_to', 'prop': 'count(account_id)', 'valueType': 'int', 'value': 20 }]
        });

        const expectedQuery = `select responsible_client_id, count(account_id) from transactions group by responsible_client_id having count(account_id)>=20`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });
});
