'use strict';

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const uuid = require('uuid/v4');
const proxyquire = require('proxyquire').noCallThru();

const selectFullQueryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectFullQuery = selectFullQueryStub;
    }
}

const audienceSelection = proxyquire('../index', {
    'rds-common': MockRdsConnection
});

const rootJSON = {
    "table": "transactions"
};

const resetStubs = () => {
    selectFullQueryStub.reset();
};
const mockAccountId = uuid();
const expectedRawQueryResult = [{ 'account_id': mockAccountId }];
const expectedParsedUserIds = [mockAccountId];


describe('Audience Selection - SQL Query Construction', () => {

    it(`should handle 'is' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" }
            ]
        });

        const expectedQuery = `select account_id from transactions where transaction_type='USER_SAVING_EVENT'`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'greater_than' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [
                    { "op": "greater_than", "prop": "creation_time", "value": "2019-08-07" }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time>'2019-08-07'`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'greater_than_or_equal_to' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [
                    { "op": "greater_than_or_equal_to", "prop": "creation_time", "value": "2019-08-07" }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time>='2019-08-07'`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'less_than' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [
                    { "op": "less_than", "prop": "creation_time", "value": "2019-08-07" }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time<'2019-08-07'`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it(`should handle 'less_than_or_equal_to' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [
                    { "op": "less_than_or_equal_to", "prop": "creation_time", "value": "2019-08-07" }
            ]
        });

        const expectedQuery = `select account_id from transactions where creation_time<='2019-08-07'`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should be able to handle simple AND statements', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                 "op": "and", "children": [
                     { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                     { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

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
        const expectedQuery = `select account_id from transactions where (transaction_type='USER_SAVING_EVENT' or settlement_status='SETTLED')`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

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

        const expectedQuery = `select account_id from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27')`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

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

        const expectedQuery = `select account_id from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or (creation_time='2019-01-27' and responsible_client_id=1))`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

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
        const expectedQuery = `select account_id from transactions where (((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27') and responsible_client_id=1)`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle random samples with conditions', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "sample": { random: 50 },
            "conditions": [{
                "op": "and", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') order by random() limit 50`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle column filters', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "columns": ["account_id", "creation_time"],
            "conditions": [{
                "op": "and", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
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
            "columns": ["responsible_client_id", "creation_time"],
            "conditions": [{
                "op": "and", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }],
            "groupBy": ["responsible_client_id"]
        });

        const expectedQuery = `select responsible_client_id, creation_time from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') group by responsible_client_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle column to count along with groupBy filters', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "columns": ["responsible_client_id"],
            "columnsToCount": ["account_id", "owner_user_id"],
            "conditions": [{
                "op": "and", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }],
            "groupBy": ["responsible_client_id"]
        });

        const expectedQuery = `select responsible_client_id, count(account_id), count(owner_user_id) from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') group by responsible_client_id`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle having filters along with column to count', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "columns": ["responsible_client_id"],
            "columnsToCount": ["account_id"],
            "groupBy": ["responsible_client_id"],
            "postConditions": [{ "op": "greater_than_or_equal_to", "prop": "count(account_id)", "type": "int", "value": 20 }]
        });

        const expectedQuery = `select responsible_client_id, count(account_id) from transactions group by responsible_client_id having count(account_id)>=20`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });
});

describe('Audience Selection - fetch users given JSON', () => {

    beforeEach(() => {
        resetStubs();
    });

    it(`should handle fetch users given 'client_id'`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [
                { "op": "is", "prop": "responsible_client_id", "value": 1, "type": "int" }
            ]
        });

        const expectedQuery = `select account_id from transactions where responsible_client_id=1`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectFullQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectFullQueryStub).to.have.been.calledOnceWithExactly(expectedQuery);
    });

    it('should get user ids based on sign_up intervals', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "conditions": [{
                "op": "and", "children": [
                    { "op": "greater_than_or_equal_to", "prop": "creation_time", "value": "2018-07-01" },
                    { "op": "less_than_or_equal_to", "prop": "creation_time", "value": "2019-11-23" }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where (creation_time>='2018-07-01' and creation_time<='2019-11-23')`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectFullQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectFullQueryStub).to.have.been.calledOnceWithExactly(expectedQuery);
    });

    it('should get user ids based on activity counts', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            "columns": ["account_id"],
            "columnsToCount": ["account_id"],
            "conditions": [{
                "op": "and", "children": [
                    { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                    { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
                ]
            }],
            "groupBy": ["account_id"],
            "postConditions": [{
                "op": "and", "children": [
                    {"op": "greater_than_or_equal_to", "prop": "count(account_id)", "type": "int", "value": 10},
                    {"op": "less_than_or_equal_to", "prop": "count(account_id)", "type": "int", "value": 50}
                ]
            }]
        });

        const expectedQuery = `select account_id, count(account_id) from transactions` +
            ` where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')` +
            ` group by account_id having (count(account_id)>=10 and count(account_id)<=50)`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectFullQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.fetchUsersGivenJSON(mockSelectionJSON);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectFullQueryStub).to.have.been.calledOnceWithExactly(expectedQuery);
    });
});
