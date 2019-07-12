'use strict';

const logger = require('debug')('jupiter:dynamo:main');
const config = require('config');

const camelcase = require('camelcase');
const decamelize = require('decamelize');

const AWS = require('aws-sdk');

const localStackHostname = process.env.LOCALSTACK_HOSTNAME;
const processInDocker = config.env === 'lamblocal' && localStackHostname;
const dynamoEndPoint = config.has('aws.endpoints.dynamodb') ? config.get('aws.endpoints.dynamodb') : null;

const endpoint = processInDocker ? `http://${localStackHostname}:4569` : dynamoEndPoint;

logger('Set endpoint for DynamoDB: ', endpoint);

AWS.config.update({ region: config.get('aws.region'), endpoint: endpoint});
// logger('Updated config to: ', config.get('aws.endpoints.dynamodb'));

const docC = new AWS.DynamoDB.DocumentClient();

// const wholeCentObject = accountIds.reduce((o, accountId) => ({ ...o, [accountId]: Math.round(Math.random() * 1000 * 100) }), {});

const nonEmptyReturnItem = (ddbResult) => ddbResult && typeof ddbResult === 'object' && ddbResult.Item && Object.keys(ddbResult.Item) !== 0;
const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});
const camelCaseKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [camelcase(key)]: object[key] }), {});

/**
 * Returns the item as an object. NB: This method enforces our convention of camel case in code and dashed in code 
 * @param {string} tableName Name of the DynamoDB table. The method assumes that the calling Lambda has the requisite permissions
 * @param {any} keyValue A map, in standard DynamoDB docClient form, of key column names and values
 * @param {array[string]} soughtAttributes Optional. A list of column names
 */
module.exports.fetchSingleRow = async (tableName = 'ConfigVars', keyValue = { keyName: 'VALUE' }, soughtAttributes = []) => {

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

const extractConditionalExpression = (rawKeyColumns) => {
    if (!Array.isArray(rawKeyColumns)) {
        throw new Error('Error! Key columns must be passed as an array');
    } else if (rawKeyColumns.length === 0) {
        throw new Error('Error! No key column names provided');
    } else if (rawKeyColumns.length > 2) {
        throw new Error('Error! Too many key column names provided, DynamoDB tables can have at most two');
    } else if (rawKeyColumns.some((keyColumn) => typeof keyColumn !== 'string')) {
        throw new Error('Error! One of the provided key column names is not a string');
    }

    const keyColumns = rawKeyColumns.map((columnName) => decamelize(columnName, '_'));
    
    const hashChar = '#';
    const columnKeyNames = keyColumns.map((keyColumnName) => hashChar + keyColumnName.charAt(0));
    const singleKey = keyColumns.length === 1;

    const exprAttrNameDict = singleKey ? { [columnKeyNames[0]]: keyColumns[0] } : {
        [columnKeyNames[0]]: keyColumns[0],
        [columnKeyNames[1]]: keyColumns[1]
    };

    const conditionalExpression = singleKey ? `attribute_not_exists(${columnKeyNames[0]})` 
        : `attribute_not_exists(${columnKeyNames[0]}) and attribute_not_exists(${columnKeyNames[1]})`;
    
    return {
        ExpressionAttributeNames: exprAttrNameDict,
        ConditionExpression: conditionalExpression
    };
};

const assembleErrorDict = (error) => {
    const ITEM_EXISTS_CODE = 'ConditionalCheckFailedException';
    const ERROR_STRING_SPACING = 2;
    
    const result = 'ERROR';
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
    const params = extractConditionalExpression(keyColumns);
    params.TableName = tableName;
    params.Item = decamelizeKeys(item);

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

/**
 * Update a single row in a table. Needs to work with the horror show of the DynamoDB SDK for this, so has to leave more to caller than usual
 * See docs here: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GettingStarted.NodeJs.03.html (Step 3.3). An example of params:
 * {
 *   tableName: 'ConfigVars', 
 *   itemKey: { keyName: keyValue }, 
 *   updateExpression: 'set property = :val', 
 *   substitutionDict: { ':val': someValue}, 
 *   returnOnlyUpdated = true
 * }
 * @param {string} tableName The name of the table where the item sits
 * @param {string} itemKey A dict, as for item fetch, with key and value (as with others, run through decamelize)
 * @param {string} updateExpression The update expression -- **note** this will not be run through decamelize so must be written with names as in table
 * @param {object} substitutionDict What to use in ExpressionAttributeValues (world's worst SDK, what can you do). Keys usually of form :s and so on, so not altered
 * @param {boolean} returnOnlyUpdated Whether to return only the updated values or all the values of the item
 */
module.exports.updateRow = async (updateParams) => {
    logger('Updating a row ...');
    
    const caseConvertedKey = decamelizeKeys(updateParams.itemKey);
    const returnValues = updateParams.returnOnlyUpdated ? 'UPDATED_NEW' : 'ALL_NEW';

    const awsParams = {
        TableName: updateParams.tableName,
        Key: caseConvertedKey,
        UpdateExpression: updateParams.updateExpression,
        ExpressionAttributeValues: updateParams.substitutionDict,
        ReturnValues: returnValues
    };

    let resultDict = { };
    try {
        logger('Updating item with params: ', awsParams);
        const updateResult = await docC.update(awsParams).promise();
        logger('Result from update: ', updateResult);
        const returnedAttributes = updateResult && updateResult['Attributes'] ? camelCaseKeys(updateResult.Attributes) : { };
        resultDict = { result: 'SUCCESS', returnedAttributes };
    } catch (err) {
        logger('Something went wrong updating! : ', err);
        resultDict = assembleErrorDict(err);
    }

    return resultDict;
};

// module.exports.debugAllTable = async (tableName) => {
//     const results = await docC.scan({ TableName: tableName }).promise();
//     logger('Results of scan: ', results);
// }
