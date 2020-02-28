'use strict';

const logger = require('debug')('jupiter:audience-selection:main');
const config = require('config');

const moment = require('moment');
const opsUtil = require('ops-util-common');

const persistence = require('./persistence');

const txTable = config.get('tables.transactionTable');
const audienceJoinTable = config.get('tables.audienceJoinTable');
const opsCommonUtil = require('ops-util-common');

const DEFAULT_TABLE = 'transactionTable';
// frontend has a complex nesteed structure that makes it very complex to insert the unit specification, hence this
const DEFAULT_BALANCE_UNIT = 'WHOLE_CURRENCY';

const stdProperties = {
    saveCount: {
        type: 'aggregate',
        description: 'Number of saves',
        expects: 'number'
    },
    currentBalance: {
      type: 'aggregate',
      description: 'Sum of account balance',
      expects: 'amount',
      unit: DEFAULT_BALANCE_UNIT
    },
    lastSaveTime: {
        type: 'match',
        description: 'Last save date',
        expects: 'epochMillis'
    },
    lastCapitalization: {
        type: 'match',
        description: 'Last capitalization',
        expects: 'epochMillis'
    },
    humanReference: {
        type: 'match',
        description: 'Human reference',
        expects: 'stringMultiple',
        table: 'accountTable'
    }
};

module.exports.fetchAvailableProperties = () => {
    const propertyKeys = Object.keys(stdProperties);
    return propertyKeys.map((name) => ({
        name, ...stdProperties[name]
    }));
};

const convertEpochToFormat = (epochMilli) => moment(parseInt(epochMilli, 10)).format();

const convertSaveCountToColumns = (condition) => {
    const columnConditions = [
        { prop: 'settlement_status', op: 'is', value: 'SETTLED' },
        { prop: 'transaction_type', op: 'is', value: 'USER_SAVING_EVENT' }
    ];

    if (Number.isInteger(condition.startTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'greater_than', value: convertEpochToFormat(condition.startTime) });
    }

    if (Number.isInteger(condition.endTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'less_than', value: convertEpochToFormat(condition.endTime) });
    }

    return {
        conditions: [{ op: 'and', children: columnConditions }],
        groupBy: ['account_id'],
        postConditions: [
            { op: condition.op, prop: 'count(transaction_id)', value: condition.value, valueType: 'int' }
        ]
    };
};

const convertSumBalanceToColumns = (condition) => {
    const settlementStatusToInclude = `'SETTLED', 'ACCRUED'`;
    const transactionTypesToInclude = `'USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'`;
    const convertAmountToSingleUnitQuery = `SUM(
        CASE
            WHEN unit = 'WHOLE_CENT' THEN
                amount / 100
            WHEN unit = 'WHOLE_CURRENCY' THEN
                amount / 10000
        ELSE
            amount
        END
    )`;
    const columnConditions = [
        { prop: 'settlement_status', op: 'in', value: settlementStatusToInclude },
        { prop: 'transaction_type', op: 'in', value: transactionTypesToInclude }
    ];

    if (Number.isInteger(condition.startTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'greater_than', value: convertEpochToFormat(condition.startTime) });
    }

    if (Number.isInteger(condition.endTime)) {
        columnConditions.push({ prop: 'creation_time', op: 'less_than', value: convertEpochToFormat(condition.endTime) });
    }

    const fromUnit = condition.unit || DEFAULT_BALANCE_UNIT;
    logger(`Transforming ${parseInt(condition.value, 10)} from ${fromUnit} to hundredth cent ...`);
    const amountInHundredthCent = opsCommonUtil.convertToUnit(parseInt(condition.value, 10), fromUnit, 'HUNDREDTH_CENT');

    return {
        conditions: [{ op: 'and', children: columnConditions }],
        groupBy: ['account_id', 'unit'],
        postConditions: [
            { op: condition.op, prop: convertAmountToSingleUnitQuery, value: amountInHundredthCent, valueType: 'int' }
        ]
    };
};

const columnConverters = {
    saveCount: (condition) => convertSaveCountToColumns(condition),
    currentBalance: (condition) => convertSumBalanceToColumns(condition),
    lastSaveTime: (condition) => ({
       conditions: [
            { op: 'and', children: [
                { op: condition.op, prop: 'creation_time', value: convertEpochToFormat(condition.value) },
                { op: 'is', prop: 'settlement_status', value: 'SETTLED' }
            ]}
       ]
    }),
    lastCapitalization: (condition) => ({
        conditions: [
            { op: 'and', children: [
                { op: condition.op, prop: 'creation_time', value: convertEpochToFormat(condition.value) },
                { op: 'is', prop: 'settlement_status', value: 'SETTLED' },
                { op: 'is', prop: 'transaction_type', value: 'CAPITALIZATION' }
            ]}
        ]
    }),
    humanReference: (condition) => ({
        conditions: [
            { op: condition.op, prop: 'human_ref', value: condition.value }
        ]
    })
};

const addTableAndClientId = (selection, clientId, tableKey) => {
    const tableName = config.get(`tables.${tableKey}`);
    const { conditions: selectionConditions } = selection;
    
    const existingTopLevel = { ...selectionConditions[0] };

    const clientColumn = tableKey === 'accountTable' ? 'responsible_client_id' : 'client_id';
    const clientCondition = { op: 'is', prop: clientColumn, value: clientId };

    let newTopLevel = {};

    // three cases: either no top level, or it's an and, so just add the client condition, or it's more complex, and need to construct a new head
    if (opsUtil.isObjectEmpty(existingTopLevel)) {
        // means no conditions provided, i.e., select whole client
        newTopLevel = clientCondition;
    } else if (existingTopLevel.op === 'and') {
        // already an 'and', so just add as another child
        const topLevelChildren = existingTopLevel.children;
        topLevelChildren.push(clientCondition);
        newTopLevel = { op: 'and', children: topLevelChildren };    
    } else {
        // the case of a top level 'or' and top-level simple operation are the same, we construct an 'and' above it
        const copiedCondition = { ...existingTopLevel };
        newTopLevel = { op: 'and', children: [clientCondition, copiedCondition] };
    }

    selectionConditions[0] = newTopLevel;
    selection.conditions = selectionConditions;

    // for future parameters we may need to revise this, but for now all relevant properties are on transactions
    selection.table = tableName || txTable;
    
    return selection;
};

const convertAggregateIntoEntity = async (aggregateCondition, persistenceParams) => {
    const converter = columnConverters[aggregateCondition.prop];
    const columnSelection = { creatingUserId: persistenceParams.creatingUserId, ...converter(aggregateCondition) };
    const clientRestricted = addTableAndClientId(columnSelection, persistenceParams.clientId, DEFAULT_TABLE);
    
    logger('Transforming aggregate condition: ', clientRestricted);
    const copiedParams = { ...persistenceParams };
    copiedParams.audienceType = 'INTERMEDIATE';
    const subAudienceResult = await persistence.executeColumnConditions(clientRestricted, true, copiedParams);
    const subAudienceId = subAudienceResult.audienceId;

    const subAudienceQuery = `select account_id from ${audienceJoinTable} where audience_id = '${subAudienceId}' and active = true`;
    return { op: 'in', prop: 'account_id', value: subAudienceQuery };
};

// requires client ID for restriction of sub-audience creation (possibly redundant, but otherwise could lead to massive inefficiency 
// & possible leaks later down the line)
const convertPropertyCondition = async (propertyCondition, persistenceParams) => {
    // first check if this combinatorial, if so, do recursion
    if (propertyCondition.op === 'or' || propertyCondition.op === 'and') {
        const childConditions = propertyCondition.children;
        const convertedChildren = await Promise.all(childConditions.map((condition) => convertPropertyCondition(condition, persistenceParams)));
        const convertedCondition = { op: propertyCondition.op, children: convertedChildren };
        return convertedCondition;
    }

    // now we are in a leaf :: if it is aggregate, at present just straight convert into matched via an insert operation;
    // obviously a lot of scope to make more efficient by eg detecting if this is necessary by checking if all nodes are 'ands' or not
    if (propertyCondition.type === 'aggregate') {
        const matchCondition = await convertAggregateIntoEntity(propertyCondition, persistenceParams);
        logger('Matched condition: ', matchCondition);
        return matchCondition;
    }
    
    // remaining is simple match condition, execute and return if it's a property, or just use the column
    if (!Object.keys(columnConverters).includes(propertyCondition.prop)) {
        logger('Should be a column: ', propertyCondition);
        return propertyCondition;
    }

    logger('Converting from property: ', propertyCondition.prop);
    const columnConverter = columnConverters[propertyCondition.prop];
    const columnCondition = columnConverter(propertyCondition);
    logger('Column condition: ', JSON.stringify(columnCondition, null, 2));
    return columnCondition.conditions[0];
};

const validateColumnConditions = (conditions) => {
    if (conditions.length === 0) {
        return;
    }
    conditions.forEach((condition) => {
        if (condition.op === 'and') {
            condition.children.forEach((child) => {
                if (child.prop === 'humanReference') {
                    throw new Error(`The 'human_ref' condition cannot be used in combination with others`);
                }
            });
        }
    });
};

const hasAccountTableProperty = (conditions) => {
    if (conditions.length === 0) {
        return false;
    }

    return conditions.some((condition) => {
        if (['and', 'or'].includes(condition.op)) {
            return hasAccountTableProperty(condition.children);
        }
        return Reflect.has(stdProperties[condition.prop], 'table');
    });
};

const extractColumnConditionsTable = (conditions) => {
    if (conditions.length === 0) {
        return false;
    }
    
    const tables = conditions.map((condition) => {
        if (['and', 'or'].includes(condition.op)) {
            return extractColumnConditionsTable(conditions);
        }
        return [stdProperties[condition.prop].table] || [];
    }).reduce((cum, list) => [...cum, ...list], []);
    
    if (tables.length > 1) {
        throw new Error('Invalid selection, spans tables. Not supported yet');
    }

    if (tables.length === 0) {
        return DEFAULT_TABLE;
    }

    return tables[0];
};

const logParams = (params) => {
    logger('Passed parameters to construct column conditions: ', JSON.stringify(params));
    if (params.conditions && params.conditions.length > 0 && (params.conditions[0].op === 'and' || params.conditions[0].op === 'or')) {
        logger('First level conditions: ', params.conditions[0].children);
    }
};

const constructColumnConditions = async (params) => {
    logParams(params);

    const passedPropertyConditions = params.conditions;
    
    const { clientId, creatingUserId, isDynamic, sample } = params;
    const persistenceParams = { 
        clientId,
        creatingUserId,
        isDynamic,
        propertyConditions: passedPropertyConditions
    };

    const columnConversions = passedPropertyConditions.map((condition) => convertPropertyCondition(condition, persistenceParams));
    const columnConditions = await Promise.all(columnConversions);
    
    const selectionObject = {
        conditions: columnConditions, creatingUserId
    };
    
    if (sample) {
        selectionObject.sample = sample;
    }

    const hasTableSpecified = hasAccountTableProperty(passedPropertyConditions);
    logger('Has table specified:', hasTableSpecified);

    const conditionTable = hasTableSpecified ? extractColumnConditionsTable(passedPropertyConditions) : DEFAULT_TABLE;
    logger('Got condition table:', conditionTable);

    const withClientId = addTableAndClientId(selectionObject, clientId, conditionTable);
    
    logger('Reassembled conditions: ', JSON.stringify(withClientId, null, 2));
    return { columnConditions: withClientId, persistenceParams };
};

module.exports.createAudience = async (params) => {
    validateColumnConditions(params.conditions);
    const { columnConditions, persistenceParams } = await constructColumnConditions(params);
    persistenceParams.audienceType = 'PRIMARY';
    
    logger('Column conditions: ', columnConditions);
    const persistedAudience = await persistence.executeColumnConditions(columnConditions, true, persistenceParams);
    logger('Received from RDS: ', persistedAudience);
    
    return persistedAudience;
};

module.exports.previewAudience = async (params) => {
    const { columnConditions } = await constructColumnConditions(params);
    const persistedAudience = await persistence.executeColumnConditions(columnConditions);

    logger('Result of preview: ', persistedAudience);

    return { audienceCount: persistedAudience.length };
};

module.exports.refreshAudience = async ({ audienceId }) => {
    logger('Proceeding to refresh audience with ID: ', audienceId);
    const audienceObject = await persistence.fetchAudience(audienceId);
    logger('Obtained audience object: ', audienceObject);
    if (!audienceObject) {
        return { result: 'Audience does not exist' };
    }

    const { isDynamic, clientId, creatingUserId, propertyConditions } = audienceObject;

    if (!isDynamic) {
        logger('No need to refresh a non-dynamic audience');
        return { result: 'Refresh not needed' };
    }

    logger('Dynamic audience, conditions: ', JSON.stringify(propertyConditions));
    await persistence.deactivateAudienceAccounts(audienceId);

    const { columnConditions } = await constructColumnConditions({ clientId, creatingUserId, ...propertyConditions });
    const fetchedAudienceAccountIdsList = await persistence.executeColumnConditions(columnConditions, false);
    await persistence.upsertAudienceAccounts(audienceId, fetchedAudienceAccountIdsList);
    logger('Completed refreshing audience');
    return { result: `Refreshed audience successfully, audience currently has ${fetchedAudienceAccountIdsList.length} members` };
};

const extractParamsFromHttpEvent = (event) => {
    const params = event.httpMethod.toUpperCase() === 'POST' ? JSON.parse(event.body) : event.queryStringParameters;
    const userDetails = opsUtil.extractUserDetails(event);
    if (params && userDetails) {
        params.creatingUserId = userDetails.systemWideUserId;
    }
    return params;
};

// utility method as essentially the same logic will be called in several different ways
const extractRequestType = (event) => {
    // if it's an http request, validate that it is admin calling, and extract from path parameters
    if (Reflect.has(event, 'httpMethod')) {
        const operation = event.pathParameters.proxy;
        const params = extractParamsFromHttpEvent(event);
        return { operation, params };
    }

    logger('Event is not http, must be another lambda, return event itself');
    return event;
};

const dispatcher = {
    'properties': () => exports.fetchAvailableProperties(),
    'create': (params) => exports.createAudience(params),
    'preview': (params) => exports.previewAudience(params),
    'refresh': (params) => exports.refreshAudience(params)
};

/**
 * Primary method. Can be called directly via invoke or as admin from form. Event or body require the following:
 * @param {object} event An event object containing the invocation payload or the request context and request body.
 * @property {string} operation A string specifying one of : create, preview, properties (path param in API call)
 * @property {object} params The body of the API call or a passed dictionary
 * @property {string} creatingUserId The ID of the user creating this (left out in POST call as obtained from header)
 * @property {string} clientId The ID of the client for which this audience is created
 * @property {boolean} isDynamic Whether or not the audience should be recalculated, e.g., for recurring messages
 * @property {object} propertyConditions The primary instruction. Contains the conditions assembled as per README. 
 */
module.exports.handleInboundRequest = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return opsUtil.wrapResponse({ }, 403);
        }

        const requestInfo = extractRequestType(event);
        const { operation, params } = requestInfo;

        const resultOfProcess = await dispatcher[operation.trim().toLowerCase()](params);
        logger('Result of audience processing: ', resultOfProcess);

        return opsUtil.wrapResponse(resultOfProcess);
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return { statusCode: 500, message: error.message };   
    }
};
