'use strict';

const logger = require('debug')('jupiter:dynamo:test');

const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
chai.use(require('sinon-chai'));
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const expect = chai.expect;

const uuid = require('uuid/v4');

const docClientGetStub = sinon.stub();
const docClientPutStub = sinon.stub();
const docClientUpdateStub = sinon.stub();

class MockDocClient {
    constructor () {
        this.get = docClientGetStub;
        this.put = docClientPutStub;
        this.update = docClientUpdateStub;
    }
}

const dynamo = proxyquire('../index', {
    'aws-sdk': { DynamoDB: { DocumentClient: MockDocClient }},
    '@noCallThru': true
});

const resetStubs = () => {
    docClientGetStub.reset();
    docClientPutStub.reset();
    docClientUpdateStub.reset();
};

const testTableName = 'ClientCoFloatTableTest';
const testClientId = 'zar_client_co';
const testFloatId = 'zar_mmkt_primary';

const testValues = {
    bonusPoolShare: 1 / 7,
    bonusPoolTracker: 'zar_mmkt_bonus_pool',
    companyShare: 0.2 / 7,
    companyShareTracker: 'pluto_za_share',
    defaultCurrency: 'ZAR'
};

describe('*** UNIT TEST SIMPLE ROW RETRIEVAL***', () => {

    const genericParams = {
        TableName: testTableName,
        Key: {
            'client_id': testClientId,
            'float_id': testFloatId
        }
    };

    afterEach(() => resetStubs());

    it('Fetch a unique record', async () => {
        logger('Initiating simplest unit test');

        const expectedResult = {
            Item: {
                'bonus_pool_share': testValues.bonusPoolShare,
                'bonus_pool_tracker': testValues.bonusPoolTracker,
                'company_share': testValues.companyShare,
                'company_share_tracker': testValues.companyShareTracker,
                'default_currency': testValues.defaultCurrency
            }
        };

        logger('Expected params: ', genericParams);
        docClientGetStub.withArgs(sinon.match(genericParams)).returns({ promise: () => expectedResult });

        const fetchVars = await dynamo.fetchSingleRow(testTableName, { clientId: testClientId, floatId: testFloatId });
        expect(fetchVars).to.exist;
        expect(fetchVars).to.deep.equal(testValues);
    });

    it('Fetch a record with a projection expression', async () => {
        const expectedParams = JSON.parse(JSON.stringify(genericParams));
        expectedParams.ProjectionExpression = 'bonus_pool_share, bonus_pool_tracker';

        const expectedResult = {
            Item: {
                'bonus_pool_share': testValues.bonusPoolShare,
                'bonus_pool_tracker': testValues.bonusPoolTracker
            }
        };

        docClientGetStub.withArgs(sinon.match(expectedParams)).returns({ promise: () => expectedResult });
        const fetchSomeVars = await dynamo.fetchSingleRow(testTableName, { clientId: testClientId, floatId: testFloatId }, 
            ['bonusPoolShare', 'bonusPoolTracker']);
        expect(fetchSomeVars).to.exist;
        expect(fetchSomeVars).to.deep.equal({ bonusPoolShare: testValues.bonusPoolShare, bonusPoolTracker: testValues.bonusPoolTracker });
        expect(docClientGetStub).to.have.been.calledWith(sinon.match(expectedParams));
        expect(docClientPutStub).to.not.has.been.called;
    });

    it('Handles empty response', async () => {
        const emptyParams = JSON.parse(JSON.stringify(genericParams));
        emptyParams['Key']['client_id'] = 'wrong_client';
        docClientGetStub.withArgs(sinon.match(emptyParams)).returns({ promise: () => ({ })});
        const noResponse = await dynamo.fetchSingleRow(testTableName, { clientId: 'wrong_client', floatId: testFloatId });
        expect(noResponse).to.deep.equal({ });
    });

    it('Throws error if get fails', async () => {
        const badTableParams = JSON.parse(JSON.stringify(genericParams));
        badTableParams['TableName'] = 'WrongTable';
        const expectedError = { 'message': 'Requested resource not found', 'code': 'ResourceNotFoundException' };
        docClientGetStub.withArgs(sinon.match(badTableParams)).returns({ promise: () => { 
            throw expectedError; 
        }});
        await expect(dynamo.fetchSingleRow('WrongTable', { clientId: testClientId, floatId: testFloatId })).to.be.
            rejectedWith(expectedError);
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
        docClientPutStub.withArgs(sinon.match(twoKeysWellFormedParams)).returns({ promise: () => { 
            throw errorResult;
        }});
        const insertRow = await dynamo.insertNewRow(floatTable, ['clientId', 'floatId'], testConfigItem);
        expect(insertRow).to.have.property('result', 'ERROR');
        expect(insertRow).to.have.property('message', 'KEY_EXISTS');
        expect(docClientPutStub).to.have.been.calledOnceWithExactly(sinon.match(twoKeysWellFormedParams));
        expect(docClientGetStub).to.not.have.been.called;
    });

    it('Error path, trying to insert a row that exists, one key', async () => {
        const errorResult = { 'message': 'The conditional request failed', 'code': 'ConditionalCheckFailedException' };
        docClientPutStub.withArgs(sinon.match(oneKeyWellFormedParams)).returns({ promise: () => { 
            throw errorResult;
        }});
        const insertRow = await dynamo.insertNewRow(userTable, ['systemWideUserId'], testUserItem);
        expect(insertRow).to.have.property('result', 'ERROR');
        expect(insertRow).to.have.property('message', 'KEY_EXISTS');
        expect(docClientPutStub).to.have.been.calledOnceWithExactly(sinon.match(oneKeyWellFormedParams));
        expect(docClientGetStub).to.not.have.been.called;
    });

    it('Throws errors if incorrect keys', async () => {
        const errorNotArray = new Error('Error! Key columns must be passed as an array');
        const errorNoKeys = new Error('Error! No key column names provided');
        const errorTooManyKeys = new Error('Error! Too many key column names provided, DynamoDB tables can have at most two');
        const errorNotString = new Error('Error! One of the provided key column names is not a string');

        // do this because rejectedWith is extremely unreliable
        await expect(dynamo.insertNewRow(userTable, 'systemWideUserId', testUserItem)).to.be.rejected.and.to.eventually.have.property('message', errorNotArray.message);
        await expect(dynamo.insertNewRow(userTable, [], testUserItem)).to.be.rejected.and.to.eventually.have.property('message', errorNoKeys.message);
        await expect(dynamo.insertNewRow(userTable, ['system', 'wide', 'id'], testUserItem)).to.be.rejected.and.to.eventually.have.property('message', errorTooManyKeys.message);
        await expect(dynamo.insertNewRow(userTable, ['systemWideUserId', 1234], testUserItem)).to.be.rejected.and.to.eventually.have.property('message', errorNotString.message);
    });
    
});

describe('*** UNIT TEST SIMPLE ROW UPDATING ***', () => {

    const testTable = 'UserProfileTable';
    const testUserId = uuid();

    const oneKeyWellFormedParams = {
        TableName: testTable,
        Key: {
            'system_wide_user_id': testUserId
        },
        UpdateExpression: 'set status = :st',
        ExpressionAttributeValues: {
            ':st': 'ACCOUNT_OPENED'
        },
        ReturnValues: 'UPDATED_NEW'
    };

    const testParams = {
        tableName: testTable,
        itemKey: { systemWideUserId: testUserId },
        updateExpression: 'set status = :st',
        substitutionDict: { ':st': 'ACCOUNT_OPENED' },
        returnOnlyUpdated: true
    };

    it('Happy path, update a user profile status', async () => {
        const ddbExpectedResult = { 'Attributes': { 'user_status': 'ACCOUNT_OPENED' }};
        docClientUpdateStub.withArgs(sinon.match(oneKeyWellFormedParams)).returns({ promise: () => ddbExpectedResult });
        const updateResult = await dynamo.updateRow(testParams);
        expect(updateResult).to.exist;
        expect(updateResult).to.have.property('result', 'SUCCESS');
        expect(updateResult).to.have.property('returnedAttributes');
        expect(updateResult.returnedAttributes).to.deep.equal({ userStatus: 'ACCOUNT_OPENED' });
        expect(docClientUpdateStub).to.have.been.calledOnceWithExactly(oneKeyWellFormedParams);
    });

    it('Throws error if error in update expression or item not found', async () => {
        const ddbError = { 'message': 'The document path provided in the update expression is invalid for update', code: 'ValidationException' };
        docClientUpdateStub.withArgs(sinon.match(oneKeyWellFormedParams)).returns({ promise: () => { 
            throw ddbError;
        }});
        const updateResult = await dynamo.updateRow(testParams);
        expect(updateResult).to.exist;
        expect(updateResult).to.have.property('result', 'ERROR');
        expect(updateResult).to.have.property('details');
        const errorBody = JSON.parse(updateResult.details);
        expect(errorBody).to.deep.equal(ddbError);
    });

});
