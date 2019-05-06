process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');
const config = require('config');

const common = require('./common');

const chai = require('chai');
const expect = chai.expect;

const AWS = require('aws-sdk');
AWS.config.update({
    region: config.get('aws.region')
});

const docClient = new AWS.DynamoDB({
    endpoint: config.get('aws.endpoints.dynamodb'),
    apiVersion: config.get('aws.apiVersion')
});

const floatDynamo = require('../persistence/dynamodb');

const createDynamoTable = (nextAction) => {
    const params = {
        TableName: config.get('tables.clientFloatVars'),
        KeySchema: [
            { AttributeName: 'VariableKey', KeyType: 'HASH' },
            { AttributeName: 'LastUpdatedTimestamp', KeyType: 'RANGE' } 
        ],
        AttributeDefinitions: [
            { AttributeName: 'VariableKey', AttributeType: 'S' },
            { AttributeName: 'LastUpdatedTimestamp', AttributeType: 'N' }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
        }
    }
    docClient.createTable(params, (err, data) => {
        if (!!err) {
            logger('Error! : ', err.message);
        } else {
            logger('Created table!');
        }
        logger('Calling next action');
        nextAction();
    });
};

const insertBonusPoolShareOfAccrual = (nextAction) => {
    const bonusKey = config.get('variableKeys.bonusPoolShare');
    logger('Inserting a value for the bonus pool share, variable key: ', bonusKey);

    const params = {
        TableName: config.get('tables.clientFloatVars'),
        Item: {
            'VariableKey': { S: bonusKey },
            'LastUpdatedTimestamp': { N: '' + (new Date()).getTime() },
            'Value': { S: '' + common.testValueBonusPoolShare }
        }
    };

    docClient.putItem(params, (err, data) => {
        if (err) { 
            logger('Error thrown inside put bonus share: ', err.message);
        } else {
            logger('Done! Bonus pool share inserted');
        }
        nextAction();
    });
};

const insertCompanyShareOfAccrual = (nextAction) => {
    logger('Inserting company share of accrual default value');
    const companyKey = config.get('variableKeys.companyShare');
    const params = {
        TableName: config.get('tables.clientFloatVars'),
        Item: {
            'VariableKey': { S: companyKey },
            'LastUpdatedTimestamp': { N: '' + (new Date()).getTime() },
            'Value': { S: '' + common.testValueCompanyShare }
        }
    };

    return docClient.putItem(params, (err, data) => {
        if (err) {
            logger('Error thrown inside put company share: ', err.message);
        } else {
            logger('Done! Company share of accrual added');
        }
        nextAction();
    });
};

const dropConfigVarTable = () => {
    const params = {
        TableName: config.get('tables.clientFloatVars')
    };

    return docClient.describeTable(params).promise().then(_ => {
        return docClient.deleteTable(params).promise().catch((err) => logger('Error thrown inside delete table: ', err.message));
    }).catch((err) => logger('Table did not exist, not dropping it'));
};

describe('obtainConfigVars', () => {

    context('Config variables exist in proper form', () => {

        before((done) => {
            // set up the stub / stick stuff into dynamodb
            logger('Inside the before for config vars exist');
            createDynamoTable(() => insertBonusPoolShareOfAccrual(() => insertCompanyShareOfAccrual(done)));
        });
    

        it('obtainBonusPoolShare', async () => {
            const retrieveShare = floatDynamo.fetchSharesAndTrackersForFloat();
            expect(retrieveShare).to.have.property('bonusPoolShare', common.testValueBonusPoolShare);
            expect(retrieveShare).to.have.property('bonusPoolSystemWideId', common.testValueBonusPoolShare)
        });
    
        it('obtainCompanyShare', async () => {
            const retrieveCoShare = floatDynamo.fetchSharesAndTrackersForFloat();
            expect(retrieveCoShare).to.have.property('clientShare', common.testValueCompanyShare);
            expect(retrieveCoShare).to.have.property('clientShareAccSystemWideId', common.testValueCompanyShare);
        });    

    });

    context('Config variables do not exist', () => {

        before(() => {
            logger('Inside the before in config vars do not exist, dropping table and recreating, so it is empty');
            return dropConfigVarTable();
        });

        it('try obtain bonus pool or company share', async () => {
            expect(floatDynamo.fetchSharesAndTrackersForFloat.bind(floatDynamo)).to.throw(ReferenceError, 'Float table does not exist!');
        });

    });
});

