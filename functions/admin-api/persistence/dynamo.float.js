'use strict';

const logger = require('debug')('pluto:admin:dynamo');
const config = require('config');

const camelCaseKeys = require('camelcase-keys');

// note: not using wrapper because scan operations in here are & should be restricted to this function
const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });
const docC = new AWS.DynamoDB.DocumentClient();

const nonEmptyReturnItem = (ddbResult) => ddbResult && typeof ddbResult === 'object' && ddbResult.Item && Object.keys(ddbResult.Item) !== 0;

// todo : restrict admin access to certain clients/floats
module.exports.listCountriesClients = async () => {
    logger('Fetching countries and clients');
    const params = {
        TableName: config.get('tables.countryClientTable')
    };

    const resultOfScan = await docC.scan(params).promise();
    return resultOfScan.Items.map((item) => camelCaseKeys(item));
};

// probably want to add a projection expression here in time
module.exports.listClientFloats = async () => {
    logger('Fetching clients and floats');
    const params = {
        TableName: config.get('tables.clientFloatTable')
    };

    const resultOfScan = await docC.scan(params).promise();
    return resultOfScan.Items.map((item) => camelCaseKeys(item));
};

module.exports.fetchClientFloatVars = async (clientId, floatId) => {
    logger(`Fetching details for client ${clientId} and float ${floatId}`);

    const params = {
        TableName: config.get('tables.clientFloatTable'),
        Key: { 'client_id': clientId, 'float_id': floatId }
    };

    const ddbResult = await docC.get(params).promise();
    logger('Result from Dynamo: ', ddbResult);

    return nonEmptyReturnItem(ddbResult) ? camelCaseKeys(ddbResult['Item']) : {};
};

module.exports.updateClientFloatVars = async (params) => {
    
};