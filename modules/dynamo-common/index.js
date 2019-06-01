'use strict';

const logger = require('debug')('pluto:dynamo:main');
const config = require('config');

const camelcase = require('camelcase');
const decamelize = require('decamelize');

const AWS = require('aws-sdk');

const endpoint = process.env.NODE_ENV === 'lamblocal' && process.env.LOCALSTACK_HOSTNAME ? 
    `http://${process.env.LOCALSTACK_HOSTNAME}:4569` : config.get('aws.endpoints.dynamodb');

logger('Set endpoint for DynamoDB: ', endpoint);

AWS.config.update({ region: config.get('aws.region'), endpoint: endpoint});
// logger('Updated config to: ', config.get('aws.endpoints.dynamodb'));

const docC = new AWS.DynamoDB.DocumentClient();

//const wholeCentObject = accountIds.reduce((o, accountId) => ({ ...o, [accountId]: Math.round(Math.random() * 1000 * 100) }), {});
        
const decamelizeKeys = (object) => Object.keys(object).reduce((o, key) => ({ ...o, [decamelize(key, '_')]: object[key] }), {});
const camelCaseKeys = (object) => Object.keys(object).reduce((o, key) => ({ ...o, [camelcase(key)]: object[key] }), {});

/**
 * Returns the item as an object. NB: This method enforces our convention of camel case in code and dashed in code 
 * @param {string} tableName Name of the DynamoDB table. The method assumes that the calling Lambda has the requisite permissions
 * @param {any} keyValue A map, in standard DynamoDB docClient form, of key column names and values
 * @param {array[string]} soughtAttributes Optional. A list of column names
 */
module.exports.fetchSingleRow = async (tableName = 'ConfigVars', keyValue = { keyName: VALUE }, soughtAttributes = []) => {
    
    const caseConvertedKey = decamelizeKeys(keyValue);
    logger('Transformed key: ', caseConvertedKey);
    const params = {
        TableName: tableName,
        Key: caseConvertedKey
    };

    if (soughtAttributes && soughtAttributes.length > 0) {
        params.ProjectionExpression = soughtAttributes.map((attr) => decamelize(attr, '_')).join(', ');
    }

    logger('Passing parameters to docClient: ', params);

    try {
        logger('Table name for DynamoDB ? :', params['TableName']);
        const ddbResult = await docC.get(params).promise();
        logger('Retrieved result: ', ddbResult);
        return camelCaseKeys(ddbResult.Item);
    } catch (e) {
        logger('Error from AWS: ', e.message);
        throw e;
    }
}
