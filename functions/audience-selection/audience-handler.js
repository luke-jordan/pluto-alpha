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

    accountOpenDays: (condition) => ({
        conditions: [converter.convertDateCondition(converter.convertCreationDaysToTime(condition), 'creation_time')]  
    }),

    humanReference: (condition) => ({
        conditions: [
            { op: condition.op, prop: 'human_ref', value: condition.op === 'is' ? condition.value.trim().toUpperCase() : converter.humanRefInValueConversion(condition.value) }
        ]
    }),

    boostNotRedeemed: (condition) => converter.convertBoostCreatedOffered(condition),
    boostOffered: (condition) => converter.convertBoostAllButCreated(condition),
    boostPendingRedeemed: (condition) => converter.convertBoostPendingRedeemed(condition),
    boostCount: (condition) => converter.convertBoostNumber(condition),

    numberFriends: (condition) => converter.convertNumberFriends(condition),

    savingHeatPoints: (condition) => converter.convertSavingHeatPoints(condition),
    savingHeatLevel: (condition) => converter.convertSavingHeatLevel(condition),
    
    systemWideUserId: (condition) => ({
        conditions: [
            { op: condition.op, prop: 'owner_user_id', value: condition.value }
        ]
    })
};

/**
 * This takes a selection object and does a final top to it, i.e., adds a client ID and a table name
 * Note : some tables do not have client IDs so need to not add (i.e., boost)
 * Note : in some cases we have converted to aggregate entities, which means we need to adjust this
 * @param {object} selection Final selection object to which table and client ID will be added
 * @param {string} clientId The client ID to be added
 * @param {string} tableKey The key for looking up the specific table to add
 */
const addTableAndClientId = (selection, clientId, tableKey) => {
    const tableName = config.get(`tables.${tableKey}`);
    const { conditions: selectionConditions } = selection;
    
    const existingTopLevel = { ...selectionConditions[0] };

    logger('Adding table and client, passed table key : ', tableKey);
    const clientColumn = tableClientIdColumns[tableKey];
    if (!clientColumn) { // then alll we need to do is stick this table key in and exit
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
    logger('Converting specific aggregate condition: ', JSON.stringify(aggregateCondition));
    const propConverter = columnConverters[aggregateCondition.prop];
    const columnSelection = { creatingUserId: persistenceParams.creatingUserId, ...propConverter(aggregateCondition) };

    const relevantTable = converter.stdProperties[aggregateCondition.prop].table || DEFAULT_TABLE;
    logger('Obtained relevant table key: ', relevantTable);
    
    const clientRestricted = addTableAndClientId(columnSelection, persistenceParams.clientId, relevantTable);
    
    logger('Transformed into column condition: ', JSON.stringify(clientRestricted, null, 2));
    const copiedParams = { ...persistenceParams };
    copiedParams.audienceType = 'INTERMEDIATE';
    const subAudienceResult = await persistence.executeColumnConditions(clientRestricted, true, copiedParams);
    const subAudienceId = subAudienceResult.audienceId;

    const subAudienceQuery = `select account_id from ${audienceJoinTable} where audience_id = '${subAudienceId}' and active = true`;
    const op = aggregateCondition.op === 'exclude' ? 'not_in' : 'in';
    return { op, prop: 'account_id', value: subAudienceQuery };
};

const hasNonDefaultTable = (conditions) => {
    if (conditions.length === 0) {
        return false;
    }

    return conditions.some((condition) => {
        if (['and', 'or'].includes(condition.op)) {
            return hasNonDefaultTable(condition.children);
        }
        return Reflect.has(converter.stdProperties[condition.prop], 'table');
    });
};

const extractTableArrayFromCondition = (condition) => {
    if (!condition) {
        return [];
    }

    if (['and', 'or'].includes(condition.op)) {
        logger('Extracting table from sub-conditions: ', condition);
        return condition.children.map((subCondition) => extractTableArrayFromCondition(subCondition)).
            reduce((list, cum) => [...list, ...cum], []);
    }

    const propTable = converter.stdProperties[condition.prop].table;
    return propTable ? [propTable] : [DEFAULT_TABLE];
};

// requires client ID for restriction of sub-audience creation (possibly redundant, but otherwise could lead to massive inefficiency 
// & possible leaks later down the line)
const convertPropertyCondition = async (propertyCondition, persistenceParams, isInMultiTableBranch) => {
    logger('Inside convert property condition, passed: ', propertyCondition);
    // first check if this combinatorial, if so, do recursion
    if (propertyCondition.op === 'or' || propertyCondition.op === 'and') {
        const childConditions = propertyCondition.children;
        // sometimes frontend sends us of the form "and" with just one child
        const childTables = [...new Set(extractTableArrayFromCondition(propertyCondition))];
        const conversions = childConditions.map((condition) => convertPropertyCondition(condition, persistenceParams, childTables.length > 1));
        const convertedChildren = await Promise.all(conversions);
        const convertedCondition = { op: propertyCondition.op, children: convertedChildren };
        return convertedCondition;
    }

    // now we are in a leaf :: if it is aggregate, at present just straight convert into matched via an insert operation;
    // obviously a lot of scope to make more efficient by eg detecting if this is necessary by checking if all nodes are 'ands' or not
    if (propertyCondition.type === 'aggregate' || isInMultiTableBranch) {
        logger('Aggregate condition, or in multi table branch, handle accordingly');
        const matchCondition = await convertAggregateIntoEntity(propertyCondition, persistenceParams);
        logger('Converted into audience-match condition: ', JSON.stringify(matchCondition));
        return matchCondition;
    }
    
    // remaining is simple match condition, execute and return if it's a property, or just use the column
    if (!Object.keys(columnConverters).includes(propertyCondition.prop)) {
        logger('Should be a column: ', propertyCondition);
        return propertyCondition;
    }

    logger('Not an aggregate-in-itself, and not inside multi-table branch, converting from property: ', propertyCondition.prop);
    const columnConverter = columnConverters[propertyCondition.prop];
    const columnCondition = columnConverter(propertyCondition);
    logger('Column condition: ', JSON.stringify(columnCondition, null, 2));
    return columnCondition.conditions[0];
};

const extractColumnConditionsTable = (conditions) => {
    if (!conditions || conditions.length === 0) {
        return false;
    }
    
    const tableDoubleArray = conditions.map((condition) => (extractTableArrayFromCondition(condition)));
    logger('Table double array: ', tableDoubleArray);

    const tables = [...new Set(tableDoubleArray.reduce((cum, list) => [...cum, ...list], []))];

    if (tables.length === 1) {
        return tables[0];
    }

    // if no table specified, we use default; if multiple, each will be converted to an aggregate, and final query will be default
    return DEFAULT_TABLE;
};

const logParams = (params) => {
    logger('Passed parameters to construct column conditions: ', JSON.stringify(params));
    if (params.conditions && params.conditions.length > 0 && (params.conditions[0].op === 'and' || params.conditions[0].op === 'or')) {
        logger('First level conditions: ', params.conditions[0].children);
    }
};

const hasAggregateCondition = (condition) => {
    if (condition.op === 'and' || condition.op === 'or') {
        return condition.children.some((child) => hasAggregateCondition(child));
    }

    return condition.type === 'aggregate';
};

const constructColumnConditions = async (params) => {
    logParams(params);

    const passedPropertyConditions = params.conditions;

    const hasTableSpecified = hasNonDefaultTable(passedPropertyConditions);
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
    
    const selectionObject = { conditions: columnConditions, creatingUserId };
    logger('Completed all constructions, object here: ', JSON.stringify(selectionObject));
    
    if (sample) {
        selectionObject.sample = sample;
    }

    // if we are now combining only aggregates, we override any skip client tests along the way, and execute
    const finalTable = passedPropertyConditions.some((condition) => hasAggregateCondition(condition)) ? DEFAULT_TABLE : conditionTable;
    const withClientId = addTableAndClientId(selectionObject, clientId, finalTable);
    
    logger('Reassembled conditions: ', JSON.stringify(withClientId, null, 2));
    return { columnConditions: withClientId, persistenceParams };
};

module.exports.createAudience = async (params) => {
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
