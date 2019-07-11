'use strict';

const logger = require('debug')('pluto:dynamo:test');
const config = require('config');

const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const expect = chai.expect;

// const AWS = require('aws-sdk');
// const ddb = new AWS.DynamoDB({apiVersion: config.get('aws.apiVersion')});
// const docC = new AWS.DynamoDB.DocumentClient({apiVersion: config.get('aws.apiVersion')});

const docClientGetStub = sinon.stub();
const docClientPutStub = sinon.stub();

class MockDocClient {
    constructor() {
        this.get = docClientGetStub;
        this.put = docClientPutStub;
    }
}

const dynamo = proxyquire('../index', {
    'aws-sdk': { DynamoDB: { DocumentClient: MockDocClient }},
    '@noCallThru': true
});

const resetStubs = () => {
    docClientGetStub.reset();
};

const testTableName = 'ClientCoFloatTableTest';
const testClientId = 'zar_client_co';
const testFloatId = 'zar_mmkt_primary';

const testValues = {
    bonusPoolShare: (1 / 7),
    bonusPoolTracker: 'zar_mmkt_bonus_pool',
    companyShare: (0.2 / 7),
    companyShareTracker: 'pluto_za_share',
    defaultCurrency: 'ZAR'
};

describe('*** UNIT TEST SIMPLE ROW RETRIEVAL***', () => {

    afterEach(() => resetStubs());

    it('Fetch a unique record', async () => {
        logger('Initiating simplest unit test');

        const expectedParams = {
            TableName: testTableName,
            Key: {
                'client_id': testClientId,
                'float_id': testFloatId
            }
        };

        const expectedResult = {
            Item: {
                'bonus_pool_share': testValues.bonusPoolShare,
                'bonus_pool_tracker': testValues.bonusPoolTracker,
                'company_share': testValues.companyShare,
                'company_share_tracker': testValues.companyShareTracker,
                'default_currency': testValues.defaultCurrency
            }
        };

        logger('Expected params: ', expectedParams);
        docClientGetStub.withArgs(sinon.match(expectedParams)).returns({ promise: () => { return expectedResult}});

        const fetchVars = await dynamo.fetchSingleRow(testTableName, { clientId: testClientId, floatId: testFloatId });
        expect(fetchVars).to.exist;
        expect(fetchVars).to.deep.equal(testValues);
    });

    it('Fetch a record with a projection expression', async () => {
        const expectedParams = {
            TableName: testTableName,
            Key: {
                'client_id': testClientId,
                'float_id': testFloatId
            },
            ProjectionExpression: 'bonus_pool_share, bonus_pool_tracker'
        };

        const expectedResult = {
            Item: {
                'bonus_pool_share': testValues.bonusPoolShare,
                'bonus_pool_tracker': testValues.bonusPoolTracker
            }
        };

        docClientGetStub.withArgs(sinon.match(expectedParams)).returns({ promise: () => { return expectedResult }});
        const fetchSomeVars = await dynamo.fetchSingleRow(testTableName, { clientId: testClientId, floatId: testFloatId }, 
            ['bonusPoolShare', 'bonusPoolTracker']);
        expect(fetchSomeVars).to.exist;
        expect(fetchSomeVars).to.deep.equal({ bonusPoolShare: testValues.bonusPoolShare, bonusPoolTracker: testValues.bonusPoolTracker });
    });



});

describe('*** UNIT TEST SIMPLE ROW INSERTION ***', () => {

    const userTable = 'UserProfileTable';

    const wellFormedParams = {
        TableName: testTableName,
        Key: {
            'client_id': testClientId,
            'float_id': testFloatId
        }
    };
    
    const expectedResult = {
        Item: { }
    };

    docClientPutStub.withArgs(sinon.match(wellFormedParams)).returns({ promise: () => { return expectedResult }});
    
    it('Happy path, simple row insertion, completion', async () => {
        const insertRow = await dynamo.putRow(userTable, { });
        expect(insertRow).to.exist;
        // then add the rest
    });
    
});

describe('*** UNIT TEST SIMPLE ROW UPDATING ***', () => {

});

describe('*** UNIT TEST ROW QUERIES AND SCANS ***', () => {

});

