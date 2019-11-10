'use strict';

const logger = require('debug')('jupiter:audience-selection:main');
const config = require('config');
const opsUtil = require('ops-util-common');

const persistence = require('./persistence');

const txTable = config.get('tables.transactionTable');

const stdProperties = {
    saveCount: {
        type: 'aggregate',
        description: 'Number of saves',
        expects: 'number'
    },
    lastSaveTime: {
        type: 'match',
        description: 'Last save date',
        expects: 'epochMillis'
    }
};

const columnConverters = {
    saveCount: (condition, clientId) => ({
        table: txTable,
        conditions: [
            { op: 'and', children: [
                { op: 'is', prop: 'client_id', value: clientId },
                { op: 'is', prop: 'settlement_status', value: 'SETTLED' }
            ]}
        ],
        groupBy: 'account_id',
        postConditions: [
            { op: condition.op, prop: 'count(transaction_id)', value: condition.value, valueType: 'int' }
        ]
    }),
    lastSaveTime: (condition) => {

    }
};

module.exports.fetchAvailableProperties = () => {
    const propertyKeys = Object.keys(stdProperties);
    return propertyKeys.map((name) => ({
        name, ...stdProperties[name]
    }));
};

module.exports.createAudience = async (params) => {
    const users = await persistence.executeColumnConditions(event, true);
    logger('Successfully retrieved users', users);
    return {
        statusCode: 200,
        message: users
    };
};

// utility method as essentially the same logic will be called in several different ways
const extractRequestType = (event) => {
    // if it's an http request, validate that it is admin calling, and extract from path parameters
    if (Reflect.has(event, 'httpMethod')) {
        const operation = event.pathParameters.proxy;
        const params = event.httpMethod === 'POST' ? JSON.parse(event.body) : event.queryStringParameters;
        return { operation, params };
    }

    logger('Event is not http, must be another lambda, return event itself')
    return event;
}

const dispatcher = {
    'properties': () => exports.fetchAvailableProperties(),
    'create': (params) => exports.createAudience(params)
};

module.exports.handleInboundRequest = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return opsUtil.wrapResponse({ }, 403);
        }

        const requestInfo = extractRequestType(event);
        const { operation, params } = requestInfo;
        
        const resultOfProcess = dispatcher[operation](params);
        logger('Result of audience processing: ', resultOfProcess);

        return opsUtil.wrapResponse(resultOfProcess);
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return { statusCode: 500, message: error.message };   
    }
};
