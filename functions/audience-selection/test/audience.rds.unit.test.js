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
const updateRecordStub = sinon.stub();
const upsertRecordsStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = selectQueryStub;
        this.freeFormInsert = freeFormStub;
        this.updateRecord = updateRecordStub;
        this.upsertRecords = upsertRecordsStub;
    }
}

const audienceSelection = proxyquire('../persistence.js', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub    
});

const rootJSON = {
    table: 'transactions'
};

const audienceTable = config.get('tables.audienceTable');
const audienceJoinTable = config.get('tables.audienceJoinTable');

const resetStubs = () => {
    selectQueryStub.reset();
    freeFormStub.reset();
    uuidStub.reset();
    updateRecordStub.reset();
    upsertRecordsStub.reset();
};

describe('Audience Selection - fetch users given JSON, end to end', () => {
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

        const expectedQuery = `select account_id from transactions where responsible_client_id=1 group by account_id`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('Should get user ids based on sign_up intervals', async () => {
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'conditions': [{
                'op': 'and', 'children': [
                    { 'op': 'greater_than_or_equal_to', 'prop': 'creation_time', 'value': '2018-07-01' },
                    { 'op': 'less_than_or_equal_to', 'prop': 'creation_time', 'value': '2019-11-23' }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions where (creation_time>='2018-07-01' and creation_time<='2019-11-23') group by account_id`;
        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('Should get user ids based on activity counts, if they are specified', async () => {
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

    it('Should convert sum balance to columns', async () => {
        const settlementStatusToInclude = ['SETTLED', 'ACCRUED'];
        const transactionTypesToInclude = ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'];
        const convertAmountToSingleUnitQuery = `SUM(
            CASE
                WHEN unit = 'WHOLE_CENT' THEN
                    amount * 100
                WHEN unit = 'WHOLE_CURRENCY' THEN
                    amount * 10000
            ELSE
                amount
            END
        )`;
        const mockSelectionJSON = Object.assign({}, rootJSON, {
            'columns': ['account_id'],
            'conditions': [{
                op: 'and',
                children: [
                    { prop: 'settlement_status', op: 'in', value: settlementStatusToInclude },
                    { prop: 'transaction_type', op: 'in', value: transactionTypesToInclude }
                ]
             }],
            'groupBy': ['account_id'],
            'postConditions': [{
                'op': 'and', 'children': [
                    { 'op': 'greater_than_or_equal_to', 'prop': convertAmountToSingleUnitQuery, 'valueType': 'int', 'value': 10 },
                    { 'op': 'less_than_or_equal_to', 'prop': convertAmountToSingleUnitQuery, 'valueType': 'int', 'value': 50 }
                ]
            }]
        });

        const expectedQuery = `select account_id from transactions` +
            ` where (settlement_status in ('SETTLED', 'ACCRUED')` +
            ` and transaction_type in ('USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'))` +
            ` group by account_id having (${convertAmountToSingleUnitQuery}>=10 and ${convertAmountToSingleUnitQuery}<=50)`;

        const sqlQuery = await audienceSelection.extractSQLQueryFromJSON(mockSelectionJSON);
        expect(sqlQuery).to.exist;
        expect(sqlQuery).to.deep.equal(expectedQuery);

        selectQueryStub.withArgs(expectedQuery).resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedParsedUserIds);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('Should execute on boost table, to select users not part of it', async () => {
        const mockSelectionJSON = {
            table: 'boost_data.boost_account_status',
            conditions: [{ op: 'and', children: [
                { prop: 'boost_id', op: 'is', value: 'this-boost-here' },
                { prop: 'boost_status', op: 'in', value: ['CREATED', 'OFFERED', 'UNLOCKED'] }
            ]}]
        };

        const expectedQuery = `select account_id from boost_data.boost_account_status where (boost_id='this-boost-here' and ` +
            `boost_status in ('CREATED', 'OFFERED', 'UNLOCKED')) group by account_id`;

        selectQueryStub.resolves(expectedRawQueryResult);

        const result = await audienceSelection.executeColumnConditions(mockSelectionJSON, false);
        expect(result).to.deep.equal(expectedParsedUserIds);

        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, emptyArray);
    });

    it('Should execute with subqueries, matching apex test in main handler', async () => {
        const mockClientId = 'test-client';
        const oneWeekAgo = moment().subtract(7, 'days');

        const expectedSubAudienceQuery = `select account_id from ${audienceJoinTable} ` + 
            `where audience_id = '${uuid()}' and active = true group by account_id`;

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

        const expectedFullQuery = `select account_id from transactions ` +
            `where (client_id='${mockClientId}' and ` +
            `((creation_time>'${oneWeekAgo.format()}' and settlement_status='SETTLED') or account_id in (${expectedSubAudienceQuery}))` +
            `) group by account_id`;

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

