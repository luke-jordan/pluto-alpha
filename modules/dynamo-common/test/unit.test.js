'use strict';

const logger = require('debug')('jupiter:dynamo:test');

const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const uuid = require('uuid/v4');

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
        expect(docClientGetStub).to.have.been.calledWith(sinon.match(expectedParams));
        expect(docClientPutStub).to.not.has.been.called;
    });



});

describe('*** UNIT TEST SIMPLE ROW INSERTION ***', () => {

    const floatTable = testTableName;
    const userTable = 'UserProfileTable';
    const testUserId = uuid();

    const twoKeysWellFormedParams = {
        TableName: floatTable,
        ExpressionAttributeNames: {
            '#c': 'client_id',
            '#f': 'float_id'
        },
        Item: {
            'client_id': testClientId,
            'float_id': testFloatId,
            'bonus_pool_system_wide_id': 'this_is_the_bonus_pool',
            'bonus_pool_share_of_accrual': '0.1'
        },
        ConditionExpression: 'attribute_not_exists(#c) and attribute_not_exists(#f)'
    };

    const oneKeyWellFormedParams = {
        TableName: userTable,
        ExpressionAttributeNames: {
            '#s': 'system_wide_user_id'
        },
        Item: {
            'system_wide_user_id': testUserId,
            'user_first_name': 'Luke',
            'user_family_name': 'Jordan',
            'client_id': testClientId,
            'float_id': testFloatId 
        },
        ConditionExpression: 'attribute_not_exists(#s)'
    };
    
    const expectedResult = { }; // what DynamoDB actually returns when successful - worst SDK

    const testConfigItem = {
        clientId: testClientId,
        floatId: testFloatId,
        bonusPoolSystemWideId: 'this_is_the_bonus_pool',
        bonusPoolShareOfAccrual: '0.1' 
    };

    const testUserItem = {
        systemWideUserId: testUserId,
        userFirstName: 'Luke',
        userFamilyName: 'Jordan',
        clientId: testClientId,
        floatId: testFloatId
    };

    afterEach(() => {
        docClientPutStub.reset();
        docClientGetStub.reset();
    });
    
    it('Happy path, simple row insertion with hash and range keys, completion', async () => {
        docClientPutStub.withArgs(sinon.match(twoKeysWellFormedParams)).returns({ promise: () => expectedResult });
        const insertRow = await dynamo.insertNewRow(floatTable, ['clientId', 'floatId'], testConfigItem);
        expect(insertRow).to.exist;
        expect(insertRow).to.have.property('result', 'SUCCESS');
        expect(docClientPutStub).to.have.been.calledOnceWithExactly(sinon.match(twoKeysWellFormedParams));
        expect(docClientGetStub).to.not.have.been.called;
    });

    it('Happy path, simple row insertion with single key, completion', async () => {
        docClientPutStub.withArgs(sinon.match(oneKeyWellFormedParams)).returns({ promise: () => expectedResult });
        const insertRow = await dynamo.insertNewRow(userTable, ['systemWideUserId'], testUserItem);
        expect(insertRow).to.exist;
        expect(insertRow).to.have.property('result', 'SUCCESS');
        expect(docClientPutStub).to.have.been.calledOnceWithExactly(sinon.match(oneKeyWellFormedParams));
        expect(docClientGetStub).to.not.have.been.called;
    });

    it('Error path, trying to insert a row that exists, two keys', async () => {
        const errorResult = { 'message': 'The conditional request failed', 'code': 'ConditionalCheckFailedException' };
        docClientPutStub.withArgs(sinon.match(twoKeysWellFormedParams)).returns({ promise: () => { throw errorResult }});
        const insertRow = await dynamo.insertNewRow(floatTable, ['clientId', 'floatId'], testConfigItem);
        expect(insertRow).to.have.property('result', 'ERROR');
        expect(insertRow).to.have.property('message', 'KEY_EXISTS');
        expect(docClientPutStub).to.have.been.calledOnceWithExactly(sinon.match(twoKeysWellFormedParams));
        expect(docClientGetStub).to.not.have.been.called;
    });

    it('Error path, trying to insert a row that exists, one key', async () => {
        const errorResult = { 'message': 'The conditional request failed', 'code': 'ConditionalCheckFailedException' };
        docClientPutStub.withArgs(sinon.match(oneKeyWellFormedParams)).returns({ promise: () => { throw errorResult }});
        const insertRow = await dynamo.insertNewRow(userTable, ['systemWideUserId'], testUserItem);
        expect(insertRow).to.have.property('result', 'ERROR');
        expect(insertRow).to.have.property('message', 'KEY_EXISTS');
        expect(docClientPutStub).to.have.been.calledOnceWithExactly(sinon.match(oneKeyWellFormedParams));
        expect(docClientGetStub).to.not.have.been.called;
    });
    
});

describe('*** UNIT TEST SIMPLE ROW UPDATING ***', () => {

});

describe('*** UNIT TEST ROW QUERIES AND SCANS ***', () => {

});

