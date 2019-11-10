'use strict';

const logger = require('debug')('jupiter:audience-selection:test');
const config = require('config');

const uuid = require('uuid/v4');
const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const executeConditionsStub = sinon.stub();
const countAudienceStub = sinon.stub();
const selectAudienceStub = sinon.stub();

const audienceHandler = proxyquire('../audience-handler', {
    'persistence': {
        'executeColumnConditions': executeConditionsStub,
        'countAudienceSize': countAudienceStub,
        'selectAudienceActive': selectAudienceStub
    }
});

const rootJSON = {
    "table": "transactions"
};

const resetStubs = () => {
    executeConditionsStub.reset();
    countAudienceStub.reset();
    selectAudienceStub.reset();
};

describe.only('Audience selection - obtain & utilize list of standard properties', () => {

    beforeEach(() => resetStubs());

    it.only('Should return acceptable properties, with types and labels', async () => {
        const activityCountProperty = { type: 'aggregate', name: 'saveCount', description: 'Number of saves', expects: 'number' };
        const lastSaveTimeProperty = { type: 'match', name: 'lastSaveTime', description: 'Last save date', expects: 'epochMillis' };
        
        const availableProperties = audienceHandler.fetchAvailableProperties();
        logger('Properties: ', availableProperties);

        expect(availableProperties).to.exist;
        expect(availableProperties).to.be.an('array');
        expect(availableProperties).to.have.length.greaterThan(1);

        expect(availableProperties).to.deep.include(activityCountProperty);
        expect(availableProperties).to.deep.include(lastSaveTimeProperty);
    });

    it.only('Should return list correctly, wrapped, in response to web request', async () => {
        const authorizedRequest = {
            httpMethod: 'get',
            pathParameters: { proxy: 'properties' },
            requestContext: { authorizer: { systemWideUserId: uuid(), role: 'SYSTEM_ADMIN' } }
        };

        const wrappedProperties = await audienceHandler.handleInboundRequest(authorizedRequest);
        logger('Wrapped response to property fetch: ', wrappedProperties);

        expect(wrappedProperties).to.have.property('statusCode', 200);
        expect(wrappedProperties).to.have.property('headers');
        expect(wrappedProperties).to.have.property('body');

        const unwrappedProps = JSON.parse(wrappedProperties.body);
        expect(unwrappedProps).to.be.an('array').of.length.greaterThan(1);
    });
});

describe('Converts standard properties into column conditions', () => {

    it('Converts properties as we wish', async () => {
        const oneWeekAgo = moment().subtract(7, 'days');
        
        const mockClientId = 'test-client-id';
        const mockSubAudienceId = uuid();

        const mockWholeAudienceId = uuid();
        const mockNumberAccounts = Math.floor(Math.random() * 1000);
        
        const mockSelectionJSON = {
            client: mockClientId,
            conditions: [
                { op: 'or', children: [
                    { op: 'greater_than', prop: 'lastSaveTime', type: 'match', value: oneWeekAgo.valueOf() },
                    { op: 'greater_than', prop: 'saveCount', type: 'aggregate', value: 3 }
                ]}
            ]
        };

        const expectedSaveCountSelection = Object.assign({}, rootJSON, {
            conditions: [
                { op: 'and', children: [
                    { op: 'is', prop: 'client_id', value: mockClientId },
                    { op: 'is', prop: 'settlement_status', value: 'SETTLED' }
                ]}
            ],
            groupBy: [
                "account_id"
            ],
            postConditions: [
                { op: 'greater_than', prop: 'count(transaction_id)', value: 3 }
            ]
        });

        const expectedSubAudienceQuery = `select account_id from ${config.get('tables.audienceTable')} ` + 
            `where audience_id = '${mockSubAudienceId}' and active = true`;
        
        const expectedWholeAudienceSelection = Object.assign({}, rootJSON, {
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

        // not actually assembled here, instead in RDS, but placing here for reference for now
        // const expectedFullQuery = `select distinct(account_id) from ${config.get('tables.transactionTable')} ` +
        //     `where (client_id = '${mockClientId} and ` +
        //     `((creation_time > '${oneWeekAgo.format()}' and settlement_status = 'SETTLED') or account_id in (${expectedSubAudienceQuery}))` +
        //     `)`;

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockSubAudienceId });
        executeConditionsStub.onSecondCall().resolves({ audienceId: mockWholeAudienceId, audienceCount: mockNumberAccounts });

        const resultOfCall = await audienceHandler.processRequestFromAnotherLambda(mockSelectionJSON);
        
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({
            statusCode: 200,
            body: JSON.stringify({ })
        });

        expect(executeConditionsStub).to.have.been.calledWith(expectedSaveCountSelection, true);
        expect(executeConditionsStub).to.have.been.calledWith(expectedWholeAudienceSelection, true);
        
    });

});
