'use strict';

const chai = require('chai');
// const sinon = require('sinon');
const expect = chai.expect;

const audienceSelection = require('../index');

const rootJSON = {
    "table": "transactions"
};

describe('Audience Selection', () => {

    it('should be able to handle simple AND statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                 "op": "and", "children": [
                     { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                     { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }]
        });

        const expectedQuery = `select * from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')`;
        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle simple OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                "op": "or", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }]
        });
        const expectedQuery = `select * from transactions where (transaction_type='USER_SAVING_EVENT' or settlement_status='SETTLED')`;
        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle simple AND and OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                "op": "or", "children": [
                    { "op": "and", "children": [
                        { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                        { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                    ]},
                    { "op": "is", "prop": "creation_time", "value": "2019-01-27" }
                ]
            }]
        });

        const expectedQuery = `select * from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27')`;
        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });


    it('should be able to handle complex AND and OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                "op": "or", "children": [
                    { "op": "and", "children": [
                        { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                        { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                    ]},
                    { "op": "and", "children": [
                        { "op": "is", "prop": "creation_time", "value": "2019-01-27" },
                        { "op": "is", "prop": "responsible_client_id", "value": 1, "type": "int" }
                     ]}
                ]
            }]
        });

        const expectedQuery = `select * from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or (creation_time='2019-01-27' and responsible_client_id=1))`;
        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle more complex AND and OR statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                "op": "and", "children": [
                    { "op": "or", "children": [
                        { "op": "and", "children": [
                                { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                                { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                        ]},
                        { "op": "is", "prop": "creation_time", "value": "2019-01-27" }
                    ]},
                    { "op": "is", "prop": "responsible_client_id", "value": 1, "type": "int" }
                ]
            }]
        });
        const expectedQuery = `select * from transactions where (((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27') and responsible_client_id=1)`;
        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle random samples with conditions', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            sample: { random: 50 },
            "conditions": [{
                "op": "and", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }]
        });

        const expectedQuery = `select * from (select * from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')) tablesample system(50)`;
        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });
});
