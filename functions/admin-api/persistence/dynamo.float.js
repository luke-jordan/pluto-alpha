'use strict';

const logger = require('debug')('pluto:admin:dynamo');
const config = require('config');

const camelCaseKeys = require('camelcase-keys');

// note: not using wrapper because scan operations in here are & should be restricted to this function
const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });
const docC = new AWS.DynamoDB.DocumentClient();

// todo : restrict admin access to certain clients/floats
module.exports.listCountriesClients = async () => {
    logger('Fetching countries and clients');
    const params = {
        TableName: config.get('tables.countryClientTable')
    };

    const resultOfScan = await docC.scan(params).promise();
    return resultOfScan.Items.map((item) => camelCaseKeys(item));
};

module.exports.listClientFloats = async () => {
    logger('Fetching clients and floats');
    const params = {
        TableName: config.get('tables.clientFloatTable')
    };

    const resultOfScan = await docC.scan(params).promise();
    return resultOfScan.Items.map((item) => camelCaseKeys(item));
};
