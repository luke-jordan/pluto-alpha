'use strict';

const logger = require('debug')('pluto:admin:dynamo');
const config = require('config');
const opsUtil = require('ops-util-common');

const camelCaseKeys = require('camelcase-keys');
const decamelize = require('decamelize');

// note: not using wrapper because scan operations in here are & should be restricted to this function
const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const docC = new AWS.DynamoDB.DocumentClient();

const nonEmptyReturnItem = (ddbResult) => ddbResult && typeof ddbResult === 'object' && ddbResult.Item && Object.keys(ddbResult.Item) !== 0;

// this is necessary because of the sheer horror of the AWS DDB SDK
const FLOAT_KEY_SUBSTITUTIONS = {
    'accrual_rate_annual_bps': ':arr',
    'bonus_pool_share_of_accrual': ':bpoolshare',
    'bonus_pool_system_wide_id': ':bpoolid',
    'client_share_of_accrual': ':csharerate',
    'client_share_system_wide_id': ':chareid',
    'currency': ':crr',
    'default_timezone': ':dts',
    'float_name': ':fname',
    'prudential_factor': ':prud',
    'user_referral_defaults': ':rffdef',
    'comparator_rates': ':crrates'
};

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

module.exports.updateClientFloatVars = async ({ clientId, floatId, newPrincipalVars, newReferralDefaults, newComparatorMap }) => {
    logger(`Updating float with client ID ${clientId}, and float ID ${floatId}, using new vars: `, newPrincipalVars);

    if (newReferralDefaults) {
        logger('Updating referral defaults to: ', newReferralDefaults);
    }

    if (newComparatorMap) {
        logger('New set of comparator variables: ', newComparatorMap);
    }

    // here we go, dynamo db sdk joyfulness in process
    const expressionClauses = [];
    const expressionMap = { };
    
    if (!opsUtil.isObjectEmpty(newPrincipalVars)) {
        const propsToUpdate = Object.keys(newPrincipalVars);
        propsToUpdate.forEach((prop) => {
            const propName = decamelize(prop, '_');
            const trimmedProp = FLOAT_KEY_SUBSTITUTIONS[propName];
            expressionClauses.push(`${propName} = ${trimmedProp}`);
            expressionMap[trimmedProp] = newPrincipalVars[prop];
        });
    }

    const assembledClause = `set ${expressionClauses.join(', ')}`;
    const params = {
        TableName: config.get('tables.clientFloatTable'),
        Key: { 'client_id': clientId, 'float_id': floatId },
        UpdateExpression: assembledClause,
        ExpressionAttributeValues: expressionMap,
        ReturnValues: 'ALL_NEW'
    };

    logger('Updating Dynamo table with params: ', params);
    const updateResult = await docC.update(params).promise();
    logger('Result from update: ', updateResult);
    const returnedAttributes = updateResult && updateResult['Attributes'] ? camelCaseKeys(updateResult['Attributes']) : { };
    return { result: 'SUCCESS', returnedAttributes };
};
