'use strict';

const logger = require('debug')('jupiter:dynamo:main');
const config = require('config');

const camelcase = require('camelcase');
const decamelize = require('decamelize');

const AWS = require('aws-sdk');

const processInDocker = process.env.NODE_ENV === 'lamblocal' && process.env.LOCALSTACK_HOSTNAME;
const endpoint = processInDocker ? `http://${process.env.LOCALSTACK_HOSTNAME}:4569` : 
    config.has('aws.endpoints.dynamodb') ? config.get('aws.endpoints.dynamodb') : null;

logger('Set endpoint for DynamoDB: ', endpoint);

AWS.config.update({ region: config.get('aws.region'), endpoint: endpoint});
// logger('Updated config to: ', config.get('aws.endpoints.dynamodb'));

const docC = new AWS.DynamoDB.DocumentClient();

//const wholeCentObject = accountIds.reduce((o, accountId) => ({ ...o, [accountId]: Math.round(Math.random() * 1000 * 100) }), {});

const nonEmptyReturnItem = (ddbResult) => ddbResult && typeof ddbResult === 'object' && ddbResult.Item && Object.keys(ddbResult.Item) !== 0;
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
        logger('Type of result: ', typeof ddbResult);
        return nonEmptyReturnItem(ddbResult) ? camelCaseKeys(ddbResult.Item) : { };
    } catch (e) {
        logger('Error from AWS: ', e.message);
        throw e;
    }
};

const extractConditionalExpression = (keyColumns) => {
    if (!Array.isArray(keyColumns)) {
        throw new Error('Error! Key columns must be passed as an array');
    } else if (keyColumns.length === 0) {
        throw new Error('Error! No key column names provided');
    } else if (keyColumns.length > 2) {
        throw new Error('Error! Too many key column names provided, DynamoDB tables can have at most two')
    } else if (keyColumns.some(keyColumn => typeof keyColumn !== 'string')) {
        throw new Error('Error! One of the provided key column names is not a string');
    }

    const hashChar = '#';
    const columnKeyNames = keyColumns.map(keyColumnName => hashChar + keyColumnName.charAt(0));
    const singleKey = keyColumns.length === 1;

    const exprAttrNameDict = singleKey ? { [columnKeyNames[0]]: keyColumns[0] } : {
        [columnKeyNames[0]]: keyColumns[0],
        [columnKeyNames[1]]: keyColumns[1]
    };

    const conditionalExpression = singleKey ? `attribute_not_exists(${columnKeyNames[0]})` :
        `attribute_not_exists(${columnKeyNames[0]}) and attribute_not_exists(${columnKeyNames[1]})`;
    
    return {
        ExpressionAttributeNames: exprAttrNameDict,
        ConditionExpression: conditionalExpression
    };
};

const assembleErrorDict = (error) => {
    const ITEM_EXISTS_CODE = 'ConditionalCheckFailedException';
    const ERROR_STRING_SPACING = 2;
    
    let result = 'ERROR';
    let message = '';
    let details = '';

    if (error.code === ITEM_EXISTS_CODE) {
        message = 'KEY_EXISTS';
    } else {
        message = 'UNKNOWN';
        details = JSON.stringify(error, null, ERROR_STRING_SPACING); 
    }

    return { result, message, details };
};

module.exports.insertNewRow = async (tableName = 'ConfigVars', keyColumns = ['clientId'], item = { }) => {
    const caseConvertedKeyColumns = keyColumns.map((columnName) => decamelize(columnName, '_'));
    const caseConvertedItem = decamelizeKeys(item);

    const params = extractConditionalExpression(caseConvertedKeyColumns);
    params.TableName = tableName;
    params.Item = caseConvertedItem;

    let resultDict = { };

    try {
        logger('Calling AWS with params: ', params);
        const resultOfPush = await docC.put(params).promise();
        logger('Successfully inserted row: ', resultOfPush);
        resultDict = { result: 'SUCCESS' };
    } catch (err) {
        logger('Error! From AWS: ', err);
        resultDict = assembleErrorDict(err);   
    }

    return resultDict;
};

// module.exports.debugAllTable = async (tableName) => {
//     const results = await docC.scan({ TableName: tableName }).promise();
//     logger('Results of scan: ', results);
// }