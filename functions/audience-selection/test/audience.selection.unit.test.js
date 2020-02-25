'use strict';

const logger = require('debug')('jupiter:audience-selection:test');
const config = require('config');

const uuid = require('uuid/v4');
const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const executeConditionsStub = sinon.stub();
const countAudienceStub = sinon.stub();
const selectAudienceStub = sinon.stub();
const deactivateAudienceAccountsStub = sinon.stub();
const upsertAudienceAccountsStub = sinon.stub();
const fetchAudienceStub = sinon.stub();

const audienceHandler = proxyquire('../audience-handler', {
    './persistence': {
        'executeColumnConditions': executeConditionsStub,
        'countAudienceSize': countAudienceStub,
        'selectAudienceActive': selectAudienceStub,
        'deactivateAudienceAccounts': deactivateAudienceAccountsStub,
        'upsertAudienceAccounts': upsertAudienceAccountsStub,
        'fetchAudience': fetchAudienceStub
    }
});

const mockUserId = uuid();
const rootJSON = {
    'creatingUserId': mockUserId,
    'table': config.get('tables.transactionTable')
};

const resetStubs = () => {
    executeConditionsStub.reset();
    countAudienceStub.reset();
    selectAudienceStub.reset();
    deactivateAudienceAccountsStub.reset();
    upsertAudienceAccountsStub.reset();
    fetchAudienceStub.reset();
};

describe('Audience selection - obtain & utilize list of standard properties', () => {

    beforeEach(() => resetStubs());

    it('Should return acceptable properties, with types and labels', async () => {
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

    it('Should return list correctly, wrapped, in response to web request', async () => {
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

    const mockClientId = 'test-client-id';
    const mockSubAudienceId = uuid();

    beforeEach(() => resetStubs());

    it('Converts properties as we wish', async () => {
        const oneWeekAgo = moment().subtract(7, 'days');
        
        const mockWholeAudienceId = uuid();
        const mockNumberAccounts = Math.floor(Math.random() * 1000);

        const mockStart = moment().subtract(30, 'days');
        
        // note 'dynamic' is a reserved word in SQL, hence using explicit 'is' prefix
        const mockSelectionJSON = {
            clientId: mockClientId,
            creatingUserId: mockUserId,
            isDynamic: true,
            conditions: [
                { op: 'or', children: [
                    { op: 'greater_than', prop: 'lastSaveTime', type: 'match', value: oneWeekAgo.valueOf() },
                    { op: 'greater_than', prop: 'saveCount', type: 'aggregate', value: 3, startTime: mockStart.valueOf() }
                ]}
            ]
        };

        const expectedSaveCountSelection = Object.assign({}, rootJSON, {
            conditions: [
                { op: 'and', children: [
                    { op: 'is', prop: 'settlement_status', value: 'SETTLED' },
                    { op: 'is', prop: 'transaction_type', value: 'USER_SAVING_EVENT' },
                    { op: 'greater_than', prop: 'creation_time', value: mockStart.format() },
                    { op: 'is', prop: 'client_id', value: mockClientId }
                ]}
            ],
            groupBy: [
                'account_id'
            ],
            postConditions: [
                { op: 'greater_than', prop: 'count(transaction_id)', value: 3, valueType: 'int' }
            ]
        });

        const expectedSubAudienceQuery = `select account_id from ${config.get('tables.audienceJoinTable')} ` + 
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

        const expectedPersistenceParams = {
            clientId: mockClientId,
            creatingUserId: mockUserId,
            isDynamic: true,
            propertyConditions: mockSelectionJSON.conditions
        };

        const intermediateParams = { ...expectedPersistenceParams, audienceType: 'INTERMEDIATE' };
        const primaryParams = { ...expectedPersistenceParams, audienceType: 'PRIMARY' };

        // not actually assembled here, instead in RDS, but placing here for reference for now (see final test in audience.rds.unit.test)
        // const expectedFullQuery = `select distinct(account_id) from ${config.get('tables.transactionTable')} ` +
        //     `where (client_id = '${mockClientId} and ` +
        //     `((creation_time > '${oneWeekAgo.format()}' and settlement_status = 'SETTLED') or account_id in (${expectedSubAudienceQuery}))` +
        //     `)`;

        executeConditionsStub.onFirstCall().resolves({ audienceId: mockSubAudienceId, audienceCount: Math.floor(mockNumberAccounts / 2) });
        executeConditionsStub.onSecondCall().resolves({ audienceId: mockWholeAudienceId, audienceCount: mockNumberAccounts });

        const resultOfCall = await audienceHandler.createAudience(mockSelectionJSON);
        
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ audienceCount: mockNumberAccounts, audienceId: mockWholeAudienceId });

        expect(executeConditionsStub).to.have.been.calledTwice;
        // these could be consolidated into a single calledWith but output then gets a bit harder to debug, so trading off some verbosity here        
        const firstCallArgs = executeConditionsStub.getCall(0).args;
        expect(firstCallArgs[0]).to.deep.equal(expectedSaveCountSelection);
        expect(firstCallArgs[1]).to.be.true;
        expect(firstCallArgs[2]).to.deep.equal(intermediateParams);

        const secondCallArgs = executeConditionsStub.getCall(1).args;
        expect(secondCallArgs[0]).to.deep.equal(expectedWholeAudienceSelection);        
        expect(secondCallArgs[1]).to.be.true;
        expect(secondCallArgs[2]).to.deep.equal(primaryParams);
    });

    it('should handle human reference audience selection properly', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: false,
            conditions: [
                { op: 'in', prop: 'humanReference', value: 'TESTREF1, TESTREF2, TESTREF3' }
            ]
        };

        const expectedSelection = {
            creatingUserId: mockUserId,
            table: 'account_data.core_account_ledger',
            conditions: [
                { op: 'and', children: [
                    { op: 'is', prop: 'responsible_client_id', value: mockClientId },
                    { op: 'in', prop: 'human_ref', value: 'TESTREF1, TESTREF2, TESTREF3' }
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

        const authorizedRequest = {
            httpMethod: 'POST',
            pathParameters: { proxy: 'create' },
            requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'SYSTEM_ADMIN' } },
            body: JSON.stringify(mockSelectionJSON)
        };

        const mockAudienceId = uuid();

        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 10000 });

        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);

        expect(wrappedResult).to.have.property('statusCode', 200);
        expect(wrappedResult).to.have.property('headers');
        expect(wrappedResult).to.have.property('body');

        const unWrappedResult = JSON.parse(wrappedResult.body);
        expect(unWrappedResult).to.deep.equal({ audienceId: mockAudienceId, audienceCount: 10000 });

        expect(executeConditionsStub).to.have.been.calledOnceWithExactly(expectedSelection, true, expectedPersistenceParams);
    });

    it('Handles the simplest case - whole client, no properties - properly', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: []
        };

        const authorizedRequest = {
            httpMethod: 'POST',
            pathParameters: { proxy: 'create' },
            requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'SYSTEM_ADMIN' } },
            body: JSON.stringify(mockSelectionJSON)
        };

        const mockAudienceId = uuid();

        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 10000 });

        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        
        expect(wrappedResult).to.have.property('statusCode', 200);
        expect(wrappedResult).to.have.property('headers');
        expect(wrappedResult).to.have.property('body');

        const unWrappedResult = JSON.parse(wrappedResult.body);
        expect(unWrappedResult).to.deep.equal({ audienceId: mockAudienceId, audienceCount: 10000 });
        
        expect(executeConditionsStub).to.have.been.calledOnce;

        // direct invoke aspects are done aboe, here just make sure extracts creating user ID properly
        const executeParams = executeConditionsStub.getCall(0).args[2];
        expect(executeParams).to.have.property('creatingUserId', mockUserId);
    });

    it('Handles preview properly', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: []
        };

        const authorizedRequest = {
            httpMethod: 'POST',
            pathParameters: { proxy: 'preview' },
            requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'SYSTEM_ADMIN' } },
            body: JSON.stringify(mockSelectionJSON)
        };

        const mockAudienceLength = 10000;

        executeConditionsStub.resolves(Array(mockAudienceLength).fill(1));

        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);        
        expect(wrappedResult).to.have.property('statusCode', 200);
        expect(wrappedResult).to.have.property('headers');
        
        const unWrappedResult = JSON.parse(wrappedResult.body);
        expect(unWrappedResult).to.deep.equal({ audienceCount: mockAudienceLength });
        
        expect(executeConditionsStub).to.have.been.calledOnce;

        // direct invoke aspects are done aboe, here just make sure sets persistence to false
        const executeParams = executeConditionsStub.getCall(0).args;
        expect(executeParams.length).to.equal(1);
    });

    it('Handles random sample case properly', async () => {
        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            sample: {
                random: 50
            },
            conditions: []
        };

        const authorizedRequest = {
            httpMethod: 'POST',
            pathParameters: { proxy: 'create' },
            requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'SYSTEM_ADMIN' } },
            body: JSON.stringify(mockSelectionJSON)
        };

        const mockAudienceId = uuid();

        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 500 });

        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);
        
        expect(wrappedResult).to.have.property('statusCode', 200);
        expect(wrappedResult).to.have.property('headers');
        expect(wrappedResult).to.have.property('body');

        const unWrappedResult = JSON.parse(wrappedResult.body);
        expect(unWrappedResult).to.deep.equal({ audienceId: mockAudienceId, audienceCount: 500 });
        
        expect(executeConditionsStub).to.have.been.calledOnce;

        const persistenceParams = executeConditionsStub.getCall(0).args[2];
        expect(persistenceParams).to.have.property('creatingUserId', mockUserId);

        const selectionJson = executeConditionsStub.getCall(0).args[0];
        expect(selectionJson).to.have.property('sample');
        expect(selectionJson.sample).to.deep.equal({ random: 50 });
    });

    it('Throws error where other condtions are included with human reference', async () => {
        const mockStart = moment().subtract(30, 'days');

        const mockSelectionJSON = {
            clientId: mockClientId,
            isDynamic: true,
            conditions: [
                { op: 'and', children: [
                        { op: 'greater_than', prop: 'humanReference', type: 'match', value: 'TESTREF123' },
                        { op: 'greater_than', prop: 'saveCount', type: 'aggregate', value: 3, startTime: mockStart.valueOf() }
                    ]}
            ]
        };

        const authorizedRequest = {
            httpMethod: 'POST',
            pathParameters: { proxy: 'create' },
            requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'SYSTEM_ADMIN' } },
            body: JSON.stringify(mockSelectionJSON)
        };

        const mockAudienceId = uuid();

        executeConditionsStub.resolves({ audienceId: mockAudienceId, audienceCount: 10000 });

        const errorResult = await audienceHandler.handleInboundRequest(authorizedRequest);

        expect(errorResult).to.have.property('statusCode', 500);
        expect(errorResult).to.have.property('message', `The 'human_ref' condition cannot be used in combination with others`);

        expect(executeConditionsStub).to.have.not.been.called;
    });

    it('Handles refresh audience request successfully when there is NO need for a refresh', async () => {
        const mockAudienceId = uuid();
        const testPropertyConditions = [
            { op: 'greater_than', prop: 'saveCount', type: 'aggregate', value: 3 }
        ];
        const testIsDynamicStatus = false;
        const mockSelectionJSON = {
            clientId: mockClientId,
            audienceId: mockAudienceId,
            isDynamic: testIsDynamicStatus,
            conditions: testPropertyConditions
        };

        const authorizedRequest = {
            httpMethod: 'POST',
            pathParameters: { proxy: 'refresh' },
            requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'SYSTEM_ADMIN' } },
            body: JSON.stringify(mockSelectionJSON)
        };


        fetchAudienceStub.withArgs(mockAudienceId).resolves({ isDynamic: testIsDynamicStatus, propertyConditions: testPropertyConditions });

        const wrappedResult = await audienceHandler.handleInboundRequest(authorizedRequest);

        expect(wrappedResult).to.have.property('statusCode', 200);
        expect(wrappedResult).to.have.property('headers');
        expect(wrappedResult).to.have.property('body');

        const unWrappedResult = JSON.parse(wrappedResult.body);
        expect(unWrappedResult).to.deep.equal({ result: 'Refresh not needed' });
        expect(fetchAudienceStub).to.have.been.calledWithExactly(mockAudienceId);
        expect(deactivateAudienceAccountsStub).to.not.have.been.called;
        expect(executeConditionsStub).to.not.have.been.called;
        expect(upsertAudienceAccountsStub).to.not.have.been.called;
    });

    it('Handles refresh audience request successfully when a REFFRESH is necessary', async () => {
            const mockAudienceId = uuid();

            const testPropertyConditions = [
                { op: 'greater_than', prop: 'saveCount', type: 'aggregate', value: 3 }
            ];
            
            const mockAudience = {
                clientId: mockClientId,
                creatingUserId: mockUserId,
                isDynamic: true,
                propertyConditions: { conditions: testPropertyConditions }
            };
            
            const invocation = {
                operation: 'refresh',
                params: { audienceId: mockAudienceId }
            };

            const testAccountId1 = uuid();
            const testAccountId2 = uuid();

            const testAudienceAccountIdsList = [testAccountId1, testAccountId2];

            // effect of with args is covered by expectations below, which provided better paths for fixing
            fetchAudienceStub.withArgs(mockAudienceId).resolves(mockAudience);
            deactivateAudienceAccountsStub.withArgs(mockAudienceId).resolves([testAccountId1]);
            executeConditionsStub.resolves(testAudienceAccountIdsList);
            upsertAudienceAccountsStub.resolves(testAudienceAccountIdsList);

            const wrappedResult = await audienceHandler.handleInboundRequest(invocation);

            expect(wrappedResult).to.have.property('statusCode', 200);
            expect(wrappedResult).to.have.property('headers');
            expect(wrappedResult).to.have.property('body');

            const unWrappedResult = JSON.parse(wrappedResult.body);
            expect(unWrappedResult).to.deep.equal({ result: `Refreshed audience successfully, audience currently has 2 members` });
            
            expect(fetchAudienceStub).to.have.been.calledOnceWithExactly(mockAudienceId);
            expect(deactivateAudienceAccountsStub).to.have.been.calledOnceWithExactly(mockAudienceId);
            
            // the ways in which execute conditions handles property conditions is dealt with above, so here just make sure 
            // that the aggregate is handled properly, i.e., there is a sub-call in the audience assembly, thus two calls in total
            expect(executeConditionsStub).to.have.been.calledTwice;
            
            expect(upsertAudienceAccountsStub).to.have.been.calledOnceWithExactly(mockAudienceId, testAudienceAccountIdsList);
        });

        it('Rejects unauthorized requests', async () => {

            const unauthorizedRequest = {
                httpMethod: 'GET',
                pathParameters: { proxy: 'preview' },
                requestContext: { authorizer: { systemWideUserId: mockUserId, role: 'ORDINARY_USER' } },
                body: JSON.stringify({})
            };

            const result = await audienceHandler.handleInboundRequest(unauthorizedRequest);
            logger('Result: ', result);

            expect(result).to.deep.equal({
                statusCode: 403,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({})
            });
        });
});
