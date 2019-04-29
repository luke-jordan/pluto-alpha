'use strict';

const logger = require('debug')('u:persistence:dynamodb');
const config = require('config');

const AWS = require('aws-sdk');

AWS.config.update({
    region: config.get('aws.region')
})
  
  // const ddb = new AWS.DynamoDB({endpoint: config.get('aws.endpoints.dynamodb')});
const docClient = new AWS.DynamoDB.DocumentClient({
    endpoint: config.get('aws.endpoints.dynamodb'),
    apiVersion: config.get('aws.apiVersion')
});

module.exports.insertAccountRecord = async (accountDetails = { 
    'accountId': 'generated-uuid',
    'userId': 'whole-of-system-unique-id', 
    'userFirstName': 'Luke',
    'userFamilyName': 'Jordan'}) => {

    logger('Inserting account with details: ', accountDetails);

    const params = {
        TableName: config.get('tables.account.dynamodb'),
        Item: {
            'AccountId': accountDetails['accountId'],
            'UserId': accountDetails['userId'],
            'UserFirstName': accountDetails['userPersonalName'],
            'UserFamilyName': accountDetails['userFamilyName'],
            'CreationTime': Date.now()
        }
    }
    
    const result = await docClient.put(params).promise();
    logger('Result: ', result);

    return { statusCode: 200 };
};