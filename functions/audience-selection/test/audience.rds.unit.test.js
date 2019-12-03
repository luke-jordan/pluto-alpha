'use strict';

const config = require('config');
const moment = require('moment');
const decamelize = require('decamelize');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const uuid = require('uuid/v4');
const proxyquire = require('proxyquire').noCallThru();

const uuidStub = sinon.stub();

const selectQueryStub = sinon.stub();
const freeFormStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = selectQueryStub;
        this.freeFormInsert = freeFormStub;
    }
}

const audienceSelection = proxyquire('../persistence.js', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub    
});

const rootJSON = {
    table: 'transactions'
};

const resetStubs = () => {
    selectQueryStub.reset();
    freeFormStub.reset();
    uuidStub.reset();
};

describe('Audience Selection - SQL Query Construction', () => {

    it(`should handle 'is' operator`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' }
            ]
        });

        const expectedQuery = `select distinct(account_id) from transactions where transaction_type='USER_SAVING_EVENT'`;
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

        const expectedQuery = `select distinct(account_id) from transactions where creation_time>'2019-08-07'`;
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

        const expectedQuery = `select distinct(account_id) from transactions where creation_time>='2019-08-07'`;
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

        const expectedQuery = `select distinct(account_id) from transactions where creation_time<'2019-08-07'`;
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

        const expectedQuery = `select distinct(account_id) from transactions where creation_time<='2019-08-07'`;
        const result = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedQuery);
    });

    it('should handle in operator', async () => {
        const mockAccountId1 = uuid();
        const mockAccountId2 = uuid();

        // looks a bit weird but is used extensively in aggregate->match conversions, and more mundanely in selecting specific accounts
        // e.g., when they come from referrals
        const mockSelectionObject = { 
            table: config.get('tables.accountTable'), 
            columns: ['account_id'],
            conditions: [{
                'op': 'in', 'prop': 'account_id', 'value': `${mockAccountId1}, ${mockAccountId2}`
            }]
        };

        const expectedQuery = `select account_id from ${config.get('tables.accountTable')} where account_id in (${mockAccountId1}, ${mockAccountId2})`;
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

        const expectedQuery = `select distinct(account_id) from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')`;
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
        const expectedQuery = `select distinct(account_id) from transactions where (transaction_type='USER_SAVING_EVENT' or settlement_status='SETTLED')`;
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

        const expectedQuery = `select distinct(account_id) from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27')`;
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

        const expectedQuery = `select distinct(account_id) from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or (creation_time='2019-01-27' and responsible_client_id=1))`;
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
        const expectedQuery = `select distinct(account_id) from transactions where (((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27') and responsible_client_id=1)`;
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

        const expectedQuery = `select distinct(account_id) from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')` +
            ` order by random() limit ((select count(*) from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')) * 0.5)`;
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

describe('Audience Selection - fetch users given JSON', () => {

    const audienceTable = config.get('tables.audienceTable');
    const audienceJoinTable = config.get('tables.audienceJoinTable'); 

    const mockAccountId = uuid();
    const expectedRawQueryResult = [{ 'account_id': mockAccountId }];
    const expectedParsedUserIds = [mockAccountId];
    const emptyArray = [];

    beforeEach(() => {
        resetStubs();
    });

    it(`should handle fetch users given 'client_id'`, async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [
                { 'op': 'is', 'prop': 'responsible_client_id', 'value': 1, 'valueType': 'int' }
            ]
        });

        const expectedQuery = `select distinct(account_id) from transactions where responsible_client_id=1`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('should get user ids based on sign_up intervals', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'greater_than_or_equal_to', 'prop': 'creation_time', 'value': '2018-07-01' },
                    { 'op': 'less_than_or_equal_to', 'prop': 'creation_time', 'value': '2019-11-23' }
                ]
            }]
        });

        const expectedQuery = `select distinct(account_id) from transactions where (creation_time>='2018-07-01' and creation_time<='2019-11-23')`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('should get user ids based on activity counts', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'columns': ['account_id'],
            'columnsToCount': ['account_id'],
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'is', 'prop': 'transaction_type', 'value': 'USER_SAVING_EVENT' },
                    { 'op': 'is', 'prop': 'settlement_status', 'value': 'SETTLED' }
                ]
            }],
            'groupBy': ['account_id'],
            'postConditions': [{
                'op': 'and', 'children': [
                    {'op': 'greater_than_or_equal_to', 'prop': 'count(account_id)', 'valueType': 'int', 'value': 10},
                    {'op': 'less_than_or_equal_to', 'prop': 'count(account_id)', 'valueType': 'int', 'value': 50}
                ]
            }]
        });

        const expectedQuery = `select account_id, count(account_id) from transactions` +
            ` where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')` +
            ` group by account_id having (count(account_id)>=10 and count(account_id)<=50)`;

        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('Should execute with subqueries, matching apex test in main handler', async () => {
        const mockClientId = 'test-client';
        const oneWeekAgo = moment().subtract(7, 'days');

        const expectedSubAudienceQuery = `select distinct(account_id) from ${audienceJoinTable} ` + 
            `where audience_id = '${uuid()}' and active = true`;

        const mockAudienceSelection = Object.assign({}, rootJSON, {
            conditions: [
                { op: 'and', children: [
                    { op: 'is', prop: 'client_id', value: mockClientId },
                    { op: 'or', children: [
                        { op: 'and', children: [
                            { op: 'greater_than', prop: 'creation_time', value: oneWeekAgo.format() },
                            { op: 'is', prop: 'settlement_status', value: 'SETTLED' }
                        ]},
                        { op: 'in', prop: 'account_id', value: expectedSubAudienceQuery }
                    ]}
                ]}
            ]
        });

        const expectedFullQuery = `select distinct(account_id) from transactions ` +
            `where (client_id='${mockClientId}' and ` +
            `((creation_time>'${oneWeekAgo.format()}' and settlement_status='SETTLED') or account_id in (${expectedSubAudienceQuery}))` +
            `)`;

        selectQueryStub.resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockAudienceSelection, false);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedFullQuery, emptyArray);
    });

    it('Should persist an audience correctly', async () => {
        const mockClientId = 'test-client';
        const mockUserId = uuid();
        const mockAudienceId = uuid();

        const propertyConditions = [{ op: 'greater_than', prop: 'saveCount', type: 'aggregate', value: 3 }];

        const mockSelection = Object.assign({}, rootJSON, {
            conditions: [
                { op: 'and', children: [
                    { op: 'is', prop: 'client_id', value: mockClientId },
                    { op: 'is', prop: 'settlement_status', value: 'SETTLED' }
                ]}
            ],
            groupBy: [
                'account_id'
            ],
            postConditions: [
                { op: 'greater_than', prop: 'count(transaction_id)', value: 3, valueType: 'int' }
            ]
        });

        const expectedAudienceObject = {
            audienceId: mockAudienceId,
            audienceType: 'PRIMARY',
            creatingUserId: mockUserId,
            clientId: mockClientId,
            selectionInstruction: mockSelection,
            isDynamic: true,
            propertyConditions: { conditions: propertyConditions }
        };

        const audienceProps = Object.keys(expectedAudienceObject); // to make sure no accidents from different sorting
        const audienceColumns = audienceProps.map((column) => decamelize(column, '_')).join(', ');
        const audienceIndices = '$1, $2, $3, $4, $5, $6, $7';

        const expectedAudienceInsertion = {
            template: `insert into ${audienceTable} (${audienceColumns}) values (${audienceIndices}) returning audience_id`,
            values: audienceProps.map((prop) => expectedAudienceObject[prop])
        };

        const expectedJoinTemplate = `insert into ${audienceJoinTable} (account_id, audience_id) ` +
            `select distinct(account_id), '${mockAudienceId}'::uuid from transactions where ` +
            `(client_id='${mockClientId}' and settlement_status='SETTLED') group by account_id ` +
            `having count(transaction_id)>3`;

        const expectedJoinQuery = { template: expectedJoinTemplate, values: [] };
        
        const persistenceParams = { creatingUserId: mockUserId, audienceType: 'PRIMARY', isDynamic: true, clientId: mockClientId, propertyConditions };
        
        uuidStub.returns(mockAudienceId);

        const mockJoinCount = 10;
        const audienceCreationResult = { rows: [{ 'audience_id': mockAudienceId }] };
        const joinInsertResult = { rowCount: mockJoinCount };
        freeFormStub.resolves([audienceCreationResult, joinInsertResult]);

        const resultOfInsertion = await audienceSelection.executeColumnConditions(mockSelection, true, persistenceParams);
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.deep.equal({ audienceId: mockAudienceId, audienceCount: mockJoinCount });

        expect(freeFormStub).to.have.been.calledWith([expectedAudienceInsertion, expectedJoinQuery]);

    });
});