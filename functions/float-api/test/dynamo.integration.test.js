process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test')
const config = require('config');

const common = require('./common');

const chai = require('chai');
const expect = chai.expect;

const AWS = require('aws-sdk');
AWS.config.update({
    region: config.get('aws.region')
})

const docClient = new AWS.DynamoDB({
    endpoint: config.get('aws.endpoints.dynamodb'),
    apiVersion: config.get('aws.apiVersion')
});


// const proxyquire = require('proxyquire').noCallThru();
// var dynamoStub = { }
// const handler = proxyquire('../handler', { './persistence/rds': dynamoStub });

const floatDynamo = require('../persistence/dynamodb');

const expectedDefaultBonusShare = 0;
const expectedDefaultCompanyShare = 0;

const createDynamoTable = (nextAction) => {
    const params = {
        TableName: config.get('tables.systemConfigVars'),
        KeySchema: [
            { AttributeName: "VariableKey", KeyType: "HASH" },
            { AttributeName: "LastUpdatedTimestamp", KeyType: "RANGE" } 
        ],
        AttributeDefinitions: [
            { AttributeName: "VariableKey", AttributeType: "S" },
            { AttributeName: "LastUpdatedTimestamp", AttributeType: "N" }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
        }
    }
    docClient.createTable(params, (err, data) => {
        if (!!err)
            logger("Error! : ", err.message)
        else
            logger("Created table!");
        logger("Calling next action");
        nextAction();
    });
};

const insertBonusPoolShareOfAccrual = (nextAction) => {
    const bonusKey = config.get('variableKeys.bonusPoolShare');
    logger('Inserting a value for the bonus pool share, variable key: ', bonusKey);

    const params = {
        TableName: config.get('tables.systemConfigVars'),
        Item: {
            'VariableKey': { S: bonusKey },
            'LastUpdatedTimestamp': { N: '' + (new Date()).getTime() },
            'Value': { S: '' + common.testValueBonusPoolShare }
        }
    };

    docClient.putItem(params, (err, data) => {
        if (err) 
            logger("Error thrown inside put bonus share: ", err.message)
        else
            logger("Done! Bonus pool share inserted");
        nextAction();
    });
}

const insertCompanyShareOfAccrual = (nextAction) => {
    logger("Inserting company share of accrual default value");
    const companyKey = config.get('variableKeys.companyShare');
    const params = {
        TableName: config.get('tables.systemConfigVars'),
        Item: {
            'VariableKey': { S: companyKey },
            'LastUpdatedTimestamp': { N: '' + (new Date()).getTime() },
            'Value': { S: '' + common.testValueCompanyShare }
        }
    };

    return docClient.putItem(params, (err, data) => {
        if (err)
            logger("Error thrown inside put company share: ", err.message);
        else
            logger("Done! Company share of accrual added");
        
        nextAction();
    });
}

const dropConfigVarTable = () => {
    const params = {
        TableName: config.get('tables.systemConfigVars')
    }

    return docClient.describeTable(params).promise().then(_ => {
        return docClient.deleteTable(params).promise().catch(err => logger("Error thrown inside delete table: ", err.message));
    }).catch(err => logger("Table did not exist, not dropping it"));
}

describe('obtainConfigVars', () => {

    context('Config variables exist in proper form', () => {

        before((done) => {
            // set up the stub / stick stuff into dynamodb
            logger('Inside the before for config vars exist');
            createDynamoTable(() => insertBonusPoolShareOfAccrual(() => insertCompanyShareOfAccrual(done)));
        });
    

        it('obtainBonusPoolShare', async () => {
            const retrieveShare = floatDynamo.fetchBonusPoolShareOfAccrual();
            expect(retrieveShare).to.exist;
            expect(retrieveShare).to.equal(testValueBonusPoolShare);
        });
    
        it('obtainCompanyShare', async () => {
            const retrieveCoShare = floatDynamo.fetchCompanyShareOfAccrual();
            expect(retrieveCoShare).to.exist;
            expect(retrieveCoShare).to.equal(testValueCompanyShare);
        });    

    });

    context('Config variables do not exist', () => {

        before(() => {
            console.log('Inside the before in config vars do not exist, dropping table and recreating, so it is empty');
            return dropConfigVarTable();
        });

        it('try obtain bonus pool share', async () => {
            const retrieveShare = floatDynamo.fetchBonusPoolShareOfAccrual();
            expect(retrieveShare).to.exist;
            expect(retrieveShare).to.equal(expectedDefaultBonusShare);
        });

        if('try obtain company share', async () => {
            const retrieveCoShare = floatDynamo.fetchCompanyShareOfAccrual();
            expect(retrieveCoShare).to.exist;
            expect(retrieveCoShare).to.equal(expectedDefaultCompanyShare);
        });

    });
});

