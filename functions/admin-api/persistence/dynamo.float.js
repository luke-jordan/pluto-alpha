'use strict';

const logger = require('debug')('jupiter:admin:dynamo');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const camelize = require('camelcase');
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
    'comparator_rates': ':crrates',
    'locked_save_bonus': ':lsbonus'
};

// because stopPaths on the library is not working and camel case flips labels to upper case on rates map (plus can exclude others later)
const untouchedKeys = ['rates', 'tags'];
const shouldTouchKeys = (key, value) => untouchedKeys.indexOf(key) < 0 && typeof value === 'object' && value !== null;

const customDeepCamelKeys = (object) => Object.keys(object).reduce((accumulator, key) => {
        const value = shouldTouchKeys(key, object[key]) ? customDeepCamelKeys(object[key]) : object[key];
        return { ...accumulator, [camelize(key)]: value };
}, {});

const customDeepDecamelKeys = (object) => Object.keys(object).reduce((accumulator, key) => {
        const value = shouldTouchKeys(key, object[key]) ? customDeepDecamelKeys(object[key]) : object[key];
        return { ...accumulator, [decamelize(key, '_')]: value };
}, {});

// not strictly float related but used all over, may split out in future
module.exports.verifyOtpPassed = async (systemWideUserId) => {
    logger('Verifying OTP ...');
    const otpVerificationEnabled = config.has('verification.otpEnabled') && config.get('verification.otpEnabled');
    if (!otpVerificationEnabled) {
        return true;
    }
    
    const userIdEventType = `${systemWideUserId}::OTP_VERIFIED`;
    const filterExpression = `expires_at >= ${moment().unix()}`;
    const docParams = {
        TableName: config.get('tables.authCacheTable'),
        Key: { 'user_id_event_type': userIdEventType },
        FilterExpression: filterExpression,
        ProjectionExpression: 'expires_at'
    };
    
    logger('Checking for OTP with params: ', docParams);
    const ddbResult = await docC.get(docParams).promise();
    if (!ddbResult || typeof ddbResult.Item !== 'object' || !ddbResult.Item) {
        return false;
    }
    
    const verificationEvent = ddbResult.Item;
    if (Object.keys(verificationEvent).length === 0) {
        return false;
    }

    if (moment().unix() > Number(verificationEvent.expiresAt)) {
        return false;
    }
    
    return true;
};

/**
 * Generic function to add a log to the admin audit table
 */
module.exports.putAdminLog = async (adminUserId, eventType, passedEvent) => {
    const putArgs = {
        TableName: config.get('tables.adminLogsTable'),
        Item: {
            'admin_user_id_event_type': `${adminUserId}::${eventType}`,
            'creation_time': moment().valueOf(),
            'context': customDeepDecamelKeys(passedEvent)
        },
        ExpressionAttributeNames: {
            '#auid': 'admin_user_id_event_type'
        },    
        ConditionExpression: 'attribute_not_exists(#auid) and attribute_not_exists(creation_time)'
    };

    try {
        logger('Inserting admin log: ', putArgs);
        const resultOfPut = await docC.put(putArgs).promise();
        logger('Result of put: ', resultOfPut);
        return { result: 'SUCCESS' };
    } catch (error) {
        logger('Error inserting admin log! From AWS: ', error);
        return { result: 'ERROR', error };
    }

};

// todo : restrict admin access to certain clients/floats
module.exports.listCountriesClients = async () => {
    logger('Fetching countries and clients');
    const params = {
        TableName: config.get('tables.countryClientTable')
    };

    const resultOfScan = await docC.scan(params).promise();
    return resultOfScan.Items.map((item) => customDeepCamelKeys(item));
};

// probably want to add a projection expression here in time
module.exports.listClientFloats = async () => {
    logger('Fetching clients and floats');
    const params = {
        TableName: config.get('tables.clientFloatTable')
    };

    const resultOfScan = await docC.scan(params).promise();
    return resultOfScan.Items.map((item) => customDeepCamelKeys(item));
};

module.exports.fetchClientFloatVars = async (clientId, floatId) => {
    logger(`Fetching details for client ${clientId} and float ${floatId}`);

    const params = {
        TableName: config.get('tables.clientFloatTable'),
        Key: { 'client_id': clientId, 'float_id': floatId }
    };

    const ddbResult = await docC.get(params).promise();
    logger('Result from Dynamo: ', ddbResult);

    return nonEmptyReturnItem(ddbResult) ? customDeepCamelKeys(ddbResult['Item']) : {};
};

// note : in future we might enforce a separate table to track this, hence using its own, with simple projection
module.exports.findCountryForClientFloat = async (clientId, floatId) => {
    const params = {
        TableName: config.get('tables.clientFloatTable'),
        Key: { 'client_id': clientId, 'float_id': floatId },
        ProjectionExpression: ['country_code']
    };

    logger('Params for obtaining country code: ', params);
    const ddbResult = await docC.get(params).promise();
    logger('Result of obtaining country code: ', ddbResult);

    return nonEmptyReturnItem(ddbResult) ? ddbResult['Item']['country_code'] : null;
};

module.exports.updateClientFloatVars = async ({ clientId, floatId, newPrincipalVars, newReferralDefaults, newComparatorMap }) => {
    logger(`Updating float with client ID ${clientId}, and float ID ${floatId}, using new vars: `, newPrincipalVars);

    // here we go, dynamo db sdk joyfulness in process
    const expressionClauses = [];
    const expressionMap = { };
    
    if (!opsUtil.isObjectEmpty(newReferralDefaults)) {
        logger('Updating referral defaults to: ', newReferralDefaults);
        const mapToInsert = customDeepDecamelKeys(newReferralDefaults);
        expressionClauses.push(`user_referral_defaults = :rffdef`);
        expressionMap[':rffdef'] = mapToInsert;
    }

    if (!opsUtil.isObjectEmpty(newComparatorMap)) {
        logger('New set of comparator variables: ', newComparatorMap);
        const mapToInsert = customDeepDecamelKeys(newComparatorMap);
        expressionClauses.push(`comparator_rates = :crmap`);
        expressionMap[':crmap'] = mapToInsert;
    }
    
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
    const returnedAttributes = updateResult && updateResult['Attributes'] ? customDeepCamelKeys(updateResult['Attributes']) : { };
    return { result: 'SUCCESS', returnedAttributes };
};

module.exports.listReferralCodes = async (clientId, floatId) => {
    logger('Obtaining referral codes for: ', clientId, ' and float: ', floatId);
    
    const queryParams = {
        TableName: config.get('tables.activeReferralCodeTable'),
        IndexName: 'ReferralCodeFloatIndex',
        KeyConditionExpression: '#cifi = :client_id_float_id',
        FilterExpression: 'code_type <> :usr',
        ExpressionAttributeNames: {
            '#cifi': 'client_id_float_id'
        },
        ExpressionAttributeValues: {
            ':client_id_float_id': `${clientId}::${floatId}`,
            ':usr': 'USER'
        }
    };

    logger('Executing query with args: ', queryParams);
    const queryResult = await docC.query(queryParams).promise();
    logger('Result from Dynamo : ', queryResult);

    if (!queryResult || typeof queryResult !== 'object' || !Array.isArray(queryResult.Items)) {
        logger('Nothing found or syntax wrong...');
        return [];    
    }

    const transformedItems = queryResult.Items.map((item) => {
        const transformedItem = customDeepCamelKeys(item);
        const clientFloat = item['client_id_float_id'].split('::');
        transformedItem.clientId = clientFloat[0];
        transformedItem.floatId = clientFloat[1];
        Reflect.deleteProperty(transformedItem, 'clientIdFloatId');
        
        if (item['context']) {
            const boostContext = customDeepCamelKeys(item['context']);
            const amountDetails = typeof boostContext.boostAmountOffered === 'string' ? boostContext.boostAmountOffered.split('::') : null;
            transformedItem.bonusAmount = amountDetails ? {
                amount: parseInt(amountDetails[0], 10),
                unit: amountDetails[1],
                currency: amountDetails[2]
            } : {};
            transformedItem.bonusSource = boostContext.bonusPoolId;
            Reflect.deleteProperty(transformedItem, 'context');
        }
        
        return transformedItem;
    });

    return transformedItems;
    
};
