'use strict';

const logger = require('debug')('jupiter:ops:common');
const config = require('config');

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

module.exports.convertToUnit = (amount, fromUnit, toUnit) => {
    if (!isUnitValid(fromUnit)) {
        throw new Error('Invalid from unit in conversion');
    }

    if (!isUnitValid(toUnit)) {
        throw new Error('Invalid to unit in conversion');
    }

    return amount * UNIT_MULTIPLIERS[fromUnit][toUnit];
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
}