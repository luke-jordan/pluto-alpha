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

// handy utility for summing over a set of rows that have different units
module.exports.sumOverUnits = (rows, targetUnit = 'HUNDREDTH_CENT', amountKey = 'sum') => 
    rows.reduce((sum, row) => {
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
            amount: this.sumOverUnits(groupedRows[currency], targetUnit, amountKey),
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

module.exports.isObjectEmpty = (object) => {
    return !object || typeof object !== 'object' || Object.keys(object).length === 0;
};
