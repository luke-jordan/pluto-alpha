'use strict';

const logger = require('debug')('jupiter:ops:common');
const config = require('config');

const decamelize = require('decamelize');

// format: from key into values, e.g., UNIT_MULTIPLIERS[WHOLE_CURRENCY][WHOLE_CENT] = 100;
const ADMISSABLE_UNITS = ['WHOLE_CURRENCY', 'WHOLE_CENT', 'HUNDREDTH_CENT'];

const UNIT_MULTIPLIERS = {
    'WHOLE_CURRENCY': {
        'HUNDREDTH_CENT': 10000,
        'WHOLE_CENT': 100,
        'WHOLE_CURRENCY': 1
    },
    'WHOLE_CENT': {
        'WHOLE_CURRENCY': 0.01,
        'WHOLE_CENT': 1,
        'HUNDREDTH_CENT': 100
    },
    'HUNDREDTH_CENT': {
        'WHOLE_CURRENCY': 0.0001,
        'WHOLE_CENT': 0.01,
        'HUNDREDTH_CENT': 1
    }
};

const isUnitValid = (unit) => ADMISSABLE_UNITS.indexOf(unit) >= 0;

module.exports.wrapResponse = (body, statusCode = 200) => {
    const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allowedCors
        },
        body: JSON.stringify(body)
    };
};

module.exports.extractSQSEvents = (sqsEvent) => sqsEvent.Records.map((record) => JSON.parse(record.body));

module.exports.extractSNSEvent = (snsEvent) => JSON.parse(snsEvent.Message);

module.exports.extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

module.exports.convertToUnit = (amount, fromUnit, toUnit) => {
    if (!isUnitValid(fromUnit)) {
        throw new Error(`Invalid from unit in conversion: ${JSON.stringify(fromUnit)}`);
    }

    if (!isUnitValid(toUnit)) {
        throw new Error(`Invalid to unit in conversion: ${JSON.stringify(toUnit)}`);
    }

    return amount * UNIT_MULTIPLIERS[fromUnit][toUnit];
};

// handy utility for summing over a set of rows that have different units
module.exports.sumOverUnits = (rows, targetUnit = 'HUNDREDTH_CENT', amountKey = 'sum') => rows.reduce((sum, row) => {
        const rowAmount = parseInt(row[amountKey], 10) * UNIT_MULTIPLIERS[row['unit']][targetUnit]; 
        return sum + rowAmount; 
    }, 0);

// note : there is probably a cleaner way to do this eventually
module.exports.assembleCurrencyTotals = (rows, targetUnit = 'HUNDREDTH_CENT', amountKey = 'sum') => {
    // first group the rows by currency
    const groupedRows = { };
    rows.forEach((row) => {
        const currency = row['currency'];
        if (!Reflect.has(groupedRows, currency)) {
            groupedRows[currency] = [];
        }
        groupedRows[currency].push(row);
    });
    const presentCurrencies = Object.keys(groupedRows);
    
    const assembledResult = { };
    presentCurrencies.forEach((currency) => {
        assembledResult[currency] = {
            amount: exports.sumOverUnits(groupedRows[currency], targetUnit, amountKey),
            unit: targetUnit
        };
    });
    return assembledResult;
};

module.exports.extractQueryParams = (event) => {
    const isEventEmpty = typeof event !== 'object' || Object.keys(event).length === 0;
    logger('Is event empty ? : ', isEventEmpty);
    if (isEventEmpty) {
        return {};
    }

    const isEventHttpGet = Reflect.has(event, 'httpMethod') && event.httpMethod === 'GET';
    if (!isEventHttpGet) {
        logger('Event has content, but is not a get method, return empty');
        return event; 
    }

    logger('Event parameters type: ', typeof event.queryStringParameters);
    const nonEmptyQueryParams = typeof event.queryStringParameters && event.queryStringParameters !== null && 
        Object.keys(event.queryStringParameters).length > 0;
    logger('Are parameters empty ? : ', nonEmptyQueryParams);

    if (nonEmptyQueryParams) {
        return event.queryStringParameters;
    }

    // must be blank, returning
    return { };
};

module.exports.isObjectEmpty = (object) => !object || typeof object !== 'object' || Object.keys(object).length === 0;

module.exports.isWarmup = (event) => {
    if (exports.isObjectEmpty(event)) {
        return true;
    }

    if (Reflect.has(event, 'warmupCall') && event.warmupCall) {
        return true;
    }

    return false;
};

module.exports.extractUserDetails = (event) => {
    if (typeof event.requestContext !== 'object') {
        return null;
    }

    if (typeof event.requestContext.authorizer !== 'object') {
        return null;
    }

    return event.requestContext.authorizer;
};

const normalizeExpectedBody = (event) => {
    // logger('Event: ', event);
    let params = { };
    if (!event.body && !event.queryStringParameters) {
        params = typeof event === 'string' ? JSON.parse(event) : event;
    } else if (typeof event.body === 'string') {
        params = JSON.parse(event.body);
    } else {
        params = event.body;
    }
    return params;
};

module.exports.extractParamsFromEvent = (event) => {
    const params = normalizeExpectedBody(event);
    if (!params || Object.keys(params).size === 0) {
        return event.queryStringParameters || event;
    }
    return params;
};

module.exports.isApiCall = (event) => Reflect.has(event, 'httpMethod'); // todo : tighten this in time

module.exports.isDirectInvokeAdminOrSelf = (event, userIdKey = 'systemWideUserId', requiresSystemAdmin = false) => {
    const isHttpRequest = Reflect.has(event, 'httpMethod'); 
    if (!isHttpRequest) {
        return true; // by definition -- means it must be via lambda direct invoke, hence allowed by IAM
    }

    const userDetails = exports.extractUserDetails(event);
    // logger('User details for call: ', userDetails);
    if (!userDetails) {
        return false;
    }

    const params = exports.extractParamsFromEvent(event);
    const needAdminRole = requiresSystemAdmin || (params[userIdKey] && userDetails.systemWideUserId !== params[userIdKey]);
    logger('Call requires admin role ? : ', needAdminRole, ' and user role: ', userDetails.role);
    
    if (needAdminRole && ['SYSTEM_ADMIN', 'SYSTEM_WORKER'].indexOf(userDetails.role) < 0) {
        return false;
    }

    // todo : probably want to add in uuid validation on id
    return Reflect.has(userDetails, 'systemWideUserId');
};

module.exports.extractPathAndParams = (event) => {
    // if it's an http request, validate that it is admin calling, and extract from path parameters
    if (Reflect.has(event, 'httpMethod')) {
        const operation = event.pathParameters.proxy;
        const params = event.httpMethod.toUpperCase() === 'POST' ? JSON.parse(event.body) : event.queryStringParameters;
        return { operation, params };
    }

    logger('Event is not http, must be another lambda, return event itself');
    return event;
};

// couple of helper methods for assembling SQL insertions; could go in rds-common/index, but that would
// then mess around, a lot, with call throughs, etc., so just placing them here
module.exports.extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

module.exports.extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
