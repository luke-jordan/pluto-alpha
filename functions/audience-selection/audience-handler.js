'use strict';

const logger = require('debug')('jupiter:audience-selection:main');
const config = require('config');

const opsUtil = require('ops-util-common');

const converter = require('./condition-converter');
const persistence = require('./persistence');

const txTable = config.get('tables.transactionTable');
const audienceJoinTable = config.get('tables.audienceJoinTable');

const DEFAULT_TABLE = 'transactionTable';

module.exports.fetchAvailableProperties = () => {
    const propertyKeys = Object.keys(converter.stdProperties);
    return propertyKeys.map((name) => ({ name, ...converter.stdProperties[name] }));
};

const tableClientIdColumns = {
    transactionTable: 'client_id',
    accountTable: 'responsible_client_id',
    boostTable: null
};

const columnConverters = {
    saveCount: (condition) => converter.convertSaveCountToColumns(condition),
    pendingCount: (condition) => converter.convertPendingCountToColumns(condition),
    anySaveCount: (condition) => converter.convertAnySaveCountToColumns(condition),

    currentBalance: (condition) => converter.convertSumBalanceToColumns(condition),
    savedThisMonth: (condition) => converter.convertSavedThisMonth(condition),
    
    lastSaveTime: (condition) => ({
        conditions: [
            { op: 'and', children: [
                { op: 'is', prop: 'settlement_status', value: 'SETTLED' },
                { op: 'is', prop: 'transaction_type', value: 'USER_SAVING_EVENT' }
            ]}
        ],
        groupBy: ['account_id'],
        postConditions: [
           { op: condition.op, prop: 'max(creation_time)', value: converter.convertEpochToFormat(condition.value) }
        ]
    }),
    lastCapitalization: (condition) => ({
        conditions: [
            { op: 'and', children: [
                converter.convertDateCondition(condition, 'creation_time'),
                { op: 'is', prop: 'settlement_status', value: 'SETTLED' },
                { op: 'is', prop: 'transaction_type', value: 'CAPITALIZATION' }
            ]}
        ]
    }),

    accountOpenTime: (condition) => ({
        conditions: [converter.convertDateCondition(condition, 'creation_time')]
    }),
    humanReference: (condition) => ({
        conditions: [
            { op: condition.op, prop: 'human_ref', value: condition.op === 'is' ? condition.value.trim().toUpperCase() : converter.humanRefInValueConversion(condition.value) }
        ]
    }),

    boostNotRedeemed: (condition) => converter.convertBoostCreatedOffered(condition),
    numberFriends: (condition) => converter.convertNumberFriends(condition),
    
    systemWideUserId: (condition) => ({
        conditions: [
            { op: condition.op, prop: 'owner_user_id', value: condition.value }
        ]
    })
};

const addTableAndClientId = (selection, clientId, tableKey) => {
    const tableName = config.get(`tables.${tableKey}`);
    const { conditions: selectionConditions } = selection;
    
    const existingTopLevel = { ...selectionConditions[0] };

    logger('*** Table Key? : ', tableKey);
    const clientColumn = tableClientIdColumns[tableKey];
    if (!clientColumn) {
        selection.table = tableName;
        return selection;
    }

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
        // the case of a top level 'or' and top-level simple operation are the same, we construct an 'and' above it, unless the property has a 'skip' attached to it
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
    const propConverter = columnConverters[aggregateCondition.prop];
    const columnSelection = { creatingUserId: persistenceParams.creatingUserId, ...propConverter(aggregateCondition) };
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
    logger('Passed property condition: ', propertyCondition);
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

// restore as part of this general tune-up
const validateColumnConditions = (conditions) => {
    if (conditions.length === 0) {
        return true;
    }
};

const hasAccountTableProperty = (conditions) => {
    if (conditions.length === 0) {
        return false;
    }

    return conditions.some((condition) => {
        if (['and', 'or'].includes(condition.op)) {
            return hasAccountTableProperty(condition.children);
        }
        return Reflect.has(converter.stdProperties[condition.prop], 'table');
    });
};

const extractTableArrayFromCondition = (condition) => {
    logger('Extracting table from condition: ', condition);
    if (!condition) {
        return [];
    }

    if (['and', 'or'].includes(condition.op)) {
        return condition.children.map((subCondition) => extractTableArrayFromCondition(subCondition)).
            reduce((list, cum) => [...list, ...cum], []);
    }

    const propTable = converter.stdProperties[condition.prop].table;
    return propTable ? [propTable] : [DEFAULT_TABLE];
};

const extractColumnConditionsTable = (conditions) => {
    if (!conditions || conditions.length === 0) {
        return false;
    }
    
    const tableDoubleArray = conditions.map((condition) => (extractTableArrayFromCondition(condition)));
    logger('Table double array: ', tableDoubleArray);

    const tables = [...new Set(tableDoubleArray.reduce((cum, list) => [...cum, ...list], []))];

    
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

    const hasTableSpecified = hasAccountTableProperty(passedPropertyConditions);
    logger('Has table specified:', hasTableSpecified);

    const conditionTable = hasTableSpecified ? extractColumnConditionsTable(passedPropertyConditions) : DEFAULT_TABLE;
    logger('Got condition table:', conditionTable);
    
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
    logger('Selection object here: ', JSON.stringify(selectionObject));
    
    if (sample) {
        selectionObject.sample = sample;
    }

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
    const { operation, params } = opsUtil.extractPathAndParams(event);
    const userDetails = opsUtil.extractUserDetails(event);
    if (params && userDetails) {
        params.creatingUserId = userDetails.systemWideUserId;
    }
    return { operation, params };
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

        // const requestInfo = extractRequestType(event);
        const { operation, params } = extractParamsFromHttpEvent(event);
        

        const resultOfProcess = await dispatcher[operation.trim().toLowerCase()](params);
        logger('Result of audience processing: ', resultOfProcess);

        return opsUtil.wrapResponse(resultOfProcess);
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return { statusCode: 500, message: error.message };   
    }
};
