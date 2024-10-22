'use strict';

const logger = require('debug')('jupiter:audience-selection:persistence');
const config = require('config');

const uuid = require('uuid/v4');
const decamelize = require('decamelize');
const camelCaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const defaultTable = config.get('tables.transactionTable');

const accountTable = config.get('tables.accountTable');
const boostTable = config.get('tables.boostTable');
const dummyTableForTests = 'transactions';

const supportedTables = [dummyTableForTests, defaultTable, accountTable, boostTable];

const audienceTable = config.get('tables.audienceTable');
const audienceJoinTable = config.get('tables.audienceJoinTable');

const HUNDRED_PERCENT = 100;

const supportedColumns = [
    'transaction_type',
    'settlement_status',
    'responsible_client_id',
    'account_id',
    'creation_time',
    'owner_user_id',
    'count(account_id)',
    'distinct(account_id)',
    'amount',
    'unit'
];

const addDefaultColumnSpecifications = (selectionJSON) => {
    if (!selectionJSON.columns) {
        const revisedJSON = { ...selectionJSON };
        revisedJSON.columns = ['account_id'];
        if (!Array.isArray(revisedJSON.groupBy)) {
            revisedJSON.groupBy = ['account_id'];
        } else if (!revisedJSON.groupBy.includes('account_id')) {
            revisedJSON.groupBy.push('account_id');
        }
        return revisedJSON;
    }
    return selectionJSON;
};

const handleInValue = (value, valueType) => {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value) && (valueType === 'int' || valueType === 'boolean')) {
        return value.map((item) => String(item)).join(', ');
    }

    if (Array.isArray(value)) {
        return value.map((item) => `'${item}'`).join(', ');
    }

    throw Error('Invalid value type for in clause');
};

const baseCaseQueryBuilder = (unit, operatorTranslated) => {
    if (unit.valueType === 'int' || unit.valueType === 'boolean') {
        return `${unit.prop}${operatorTranslated}${unit.value}`;
    }

    if (operatorTranslated === 'in' || operatorTranslated === 'not in') {
        return `${unit.prop} ${operatorTranslated} (${handleInValue(unit.value, unit.valueType)})`;
    }

    return `${unit.prop}${operatorTranslated}'${unit.value}'`;
};

const conditionsFilterBuilder = (unit) => {
    // base cases
    if (unit.op === 'is') {
        return baseCaseQueryBuilder(unit, '=');
    }

    if (unit.op === 'not') {
        return baseCaseQueryBuilder(unit, ' != '); // just so ! has some breathing space
    }

    if (unit.op === 'greater_than') {
        return baseCaseQueryBuilder(unit, '>');
    }

    if (unit.op === 'greater_than_or_equal_to') {
        return baseCaseQueryBuilder(unit, '>=');
    }

    if (unit.op === 'less_than') {
        return baseCaseQueryBuilder(unit, '<');
    }

    if (unit.op === 'less_than_or_equal_to') {
        return baseCaseQueryBuilder(unit, '<=');
    }

    if (unit.op === 'in') {
        return baseCaseQueryBuilder(unit, 'in');
    }

    if (unit.op === 'not_in') {
        return baseCaseQueryBuilder(unit, 'not in');
    }

    // end of base cases

    if (unit.op === 'and' && unit.children) {
        return '(' + unit.children.map((innerUnit) => conditionsFilterBuilder(innerUnit)).join(' and ') + ')';
    }

    if (unit.op === 'or' && unit.children) {
        return '(' + unit.children.map((innerUnit) => conditionsFilterBuilder(innerUnit)).join(' or ') + ')';
    }
};

const extractWhereConditions = (selectionJSON) => {
    if (selectionJSON.conditions) {
        return selectionJSON.conditions.map((block) => conditionsFilterBuilder(block)).join('');
    }
};

// escape supported columns to allow for selecting constants (as in insert), but prevent injection 
// return columns.map((column) => supportedColumns.includes(column));    
const validateAndParseColumns = (columns) => columns.map((column) => (supportedColumns.includes(column) ? column : `'${column}'`));

const extractColumnsToCount = (selectionJSON) => {
    if (selectionJSON.columnsToCount) {
        return validateAndParseColumns(selectionJSON.columnsToCount).
            map((filteredColumn) => `count(${filteredColumn})`).
            join(', ');
    }
};

const extractColumnsToSum = (selectionJSON) => {
    if (selectionJSON.columnsToSum) {
        return validateAndParseColumns(selectionJSON.columnsToSum).
            map((filteredColumn) => `sum(${filteredColumn})`).
            join(', ');
    }
};

const extractColumns = (selectionJSON) => {
    if (selectionJSON.columns) {
        return validateAndParseColumns(selectionJSON.columns).join(', ');
    }

    throw new Error('No column specified or added prior to processing');
};

const extractTable = (selectionJSON) => {
    if (!selectionJSON.table) {
        return defaultTable;
    }

    if (!supportedTables.includes(selectionJSON.table)) {
        throw new Error('Table not supported at the moment');
    }

    return selectionJSON.table;
};

const extractGroupBy = (selectionJSON) => {
    if (selectionJSON.groupBy) {
        return validateAndParseColumns(selectionJSON.groupBy).join(', ');
    }
};

const extractHavingFilter = (selectionJSON) => {
    if (selectionJSON.postConditions) {
        return selectionJSON.postConditions.map((block) => conditionsFilterBuilder(block)).join('');
    }
};

const checkRandomSampleExpectation = (selectionJSON) => {
    if (selectionJSON.sample && selectionJSON.sample.random) {
        return true;
    }

    return false;
};

const addWhereFiltersToQuery = (whereFilters, query) => {
    if (whereFilters) {
        return `${query} where ${whereFilters}`;
    }
    return query;
};

const addGroupByFiltersToQuery = (groupByFilters, query) => {
    if (groupByFilters) {
        return `${query} group by ${groupByFilters}`;
    }
    return query;
};

const addHavingFiltersToQuery = (havingFilters, query) => {
    if (havingFilters) {
        return `${query} having ${havingFilters}`;
    }
    return query;
};

const getLimitForRandomSample = (filters, value) => {
    const {
        table,
        whereFilters,
        havingFilters
    } = filters;

    let query = `select count(distinct(account_id)) from ${table}`;
    
    // have to remove it otherwise returns counts per account id (and may either have come in via caller or in default wrapper method)
    let { groupByFilters } = filters;  
    if (typeof groupByFilters === 'string' && groupByFilters.length > 0 && groupByFilters.includes('account_id')) {
        const groupBy = groupByFilters.split(', ').filter((column) => column !== 'account_id');
        groupByFilters = extractGroupBy({ groupBy });
    }

    query = addWhereFiltersToQuery(whereFilters, query);
    query = addGroupByFiltersToQuery(groupByFilters, query);
    query = addHavingFiltersToQuery(havingFilters, query);

    const percentageAsFraction = value / HUNDRED_PERCENT;
    return `((${query}) * ${percentageAsFraction})`;
};

// todo : add end to end tests for this (i.e., if it comes in with 'sample', it goes out with the order by clause on the query)
const addRandomExpectationToQuery = (query, filters, selectionJSON) => {
    if (checkRandomSampleExpectation(selectionJSON)) {
        const limitValue = getLimitForRandomSample(filters, selectionJSON.sample.random);
        return `${query} order by random() limit ${limitValue}`;
    }
    return query;
};

const constructFullQuery = (selectionJSON, parsedValues) => {
    const {
        columns,
        columnsToCount,
        columnsToSum,
        table,
        whereFilters,
        groupByFilters,
        havingFilters
    } = parsedValues;

    const initialColumnsToFetch = columnsToCount ? `${columns}, ${columnsToCount}` : columns;
    const allColumnsToFetch = columnsToSum ? `${initialColumnsToFetch}, ${columnsToSum}` : initialColumnsToFetch;

    let mainQuery = `select ${allColumnsToFetch} from ${table}`;

    mainQuery = addWhereFiltersToQuery(whereFilters, mainQuery);
    mainQuery = addGroupByFiltersToQuery(groupByFilters, mainQuery);
    mainQuery = addHavingFiltersToQuery(havingFilters, mainQuery);

    const filters = {
        table,
        whereFilters,
        groupByFilters,
        havingFilters
    };
    mainQuery = addRandomExpectationToQuery(mainQuery, filters, selectionJSON);

    return mainQuery;
};

module.exports.extractSQLQueryFromJSON = (passedJSON) => {
    logger('Extracting sql query from passed JSON: ', JSON.stringify(passedJSON));

    const selectionJSON = addDefaultColumnSpecifications(passedJSON);

    const columns = extractColumns(selectionJSON);
    const columnsToCount = extractColumnsToCount(selectionJSON);
    const columnsToSum = extractColumnsToSum(selectionJSON);
    const table = extractTable(selectionJSON);
    const whereFilters = extractWhereConditions(selectionJSON);
    const groupByFilters = extractGroupBy(selectionJSON);
    const havingFilters = extractHavingFilter(selectionJSON);

    // logger('parsed columns:', columns);
    // logger('parsed table:', table);
    // logger('where filters:', whereFilters);
    // logger('parsed columns to count:', columnsToCount);
    // logger('parsed columns to sum:', columnsToSum);
    // logger('groupBy filters:', groupByFilters);
    // logger('having filters:', havingFilters);

    const parsedValues = {
        columns,
        columnsToCount,
        columnsToSum,
        table,
        whereFilters,
        groupByFilters,
        havingFilters
    };

    const fullQuery = constructFullQuery(selectionJSON, parsedValues);
    logger('====> Now have Full sql query:', fullQuery);

    return fullQuery;
};

// note : this is the only method authorized to use free form insert (via that method rejecting any other role / tables)
const insertQuery = async (selectionJSON, persistenceParams) => {
        
    const audienceId = uuid();

    const audienceObject = { 
        audienceId,
        audienceType: persistenceParams.audienceType,
        creatingUserId: persistenceParams.creatingUserId,
        clientId: persistenceParams.clientId,
        selectionInstruction: selectionJSON,
        isDynamic: persistenceParams.isDynamic || false
    };

    if (persistenceParams.propertyConditions) {
        audienceObject.propertyConditions = { conditions: persistenceParams.propertyConditions }; // to distinguish from JSON for Postgres
    }

    const audienceProps = Object.keys(audienceObject); // to make sure no accidents from different sorting
    const audienceColumns = audienceProps.map((column) => decamelize(column, '_')).join(', ');

    const columnIndices = audienceProps.map((prop, index) => `$${index + 1}`).join(', ');
    const columnValues = audienceProps.map((prop) => audienceObject[prop]); // again, instead of Object.values, to keep order
    const createAudienceTemplate = `insert into ${audienceTable} (${audienceColumns}) values (${columnIndices}) returning audience_id`;
    
    const createAudienceQuery = { template: createAudienceTemplate, values: columnValues };
    logger('Create audience query: ', JSON.stringify(createAudienceQuery));

    // rely on query construction engine to do the insertion query as we need it
    const insertionJSON = { ...selectionJSON };
    insertionJSON.columns = ['distinct(account_id)', audienceId];
    const selectForInsert = exports.extractSQLQueryFromJSON(insertionJSON, persistenceParams);

    // use the compiled selection in the insert query, after converting ID to UUID
    const crossInsertionTemplate = `insert into ${audienceJoinTable} (account_id, audience_id) ${selectForInsert}`.
        replace(`'${audienceId}'`, `'${audienceId}'::uuid`);
    
    const joinInsertionQuery = { template: crossInsertionTemplate, values: [] };
    logger('*** ======= Compiled query: ', joinInsertionQuery);

    const joinResult = await rdsConnection.freeFormInsert([createAudienceQuery, joinInsertionQuery]);
    // logger('Join result: ', joinResult);

    const audienceCount = joinResult[1]['rowCount'];

    const persistenceResult = {
        audienceId,
        audienceCount
    };

    return persistenceResult;
};

/**
 * Called right at the end when the column conditions are all in good oder. For selection query only, just past the object.
 * If the audience is to be persisted, set persistSelection to true and pass these parameters:
 * @param {object} persistenceParams A map of properties for the audience
 * @property {string} creatingUserId Who is creating this audience
 * @property {string} clientId What client is responsible for it
 * @property {boolean} isDynamic (Optional) Defaults to false. Set to true if audience should be recalculated when it is used (e.g., if for a recurring message)
 * @property {object} propertyConditions (Optional) Preserves the original property conditions that gave rise to this audience. Note: the column conditions created from those properties are always stored.
 */
module.exports.executeColumnConditions = async (selectionJSON, persistSelection = false, persistenceParams = null) => {
    if (persistSelection) {
        logger('Persisting an audience, according to: ', selectionJSON);
        const persistenceResult = await insertQuery(selectionJSON, persistenceParams);
        logger('Result of persistence: ', persistenceResult);
        return persistenceResult;
    } 
    
    logger('Selecting accounts according to: ', JSON.stringify(selectionJSON));
    const sqlQuery = exports.extractSQLQueryFromJSON(selectionJSON);
    const queryResult = await rdsConnection.selectQuery(sqlQuery, []);
    logger('Number of records from query: ', queryResult.length);
    return queryResult.map((row) => row['account_id']);
};

// NOTE: not being used at the moment, perhaps will be used later
module.exports.countAudienceSize = async (audienceId, activeOnly = true) => {
    const query = `select count(account_id) from ${audienceJoinTable} where audience_id = $1` + 
        `${activeOnly ? ' and active = true' : ''}`;

    logger('Counting audience size, with query: ', query);
    const resultOfQuery = await rdsConnection.selectQuery(query, [audienceId]);
    logger('Result of audience count: ', resultOfQuery);
    return resultOfQuery[0]['count'];
};

// NOTE: not being used at the moment, perhaps will be used later
module.exports.selectAudienceActive = async (audienceId, activeOnly = true) => {
    const query = `select account_id from ${audienceJoinTable} where audience_id = $1` +
        `${activeOnly ? ' and active = true' : ''}`;
    
    logger('Retrieving audience with query: ', query);
    const queryResult = await rdsConnection.selectQuery(query, [audienceId]);
    return queryResult.map((row) => row['account_id']);
};

module.exports.deactivateAudienceAccounts = async (audienceId) => {
    const query = `update ${config.get('tables.audienceJoinTable')} set active = false where audience_id = $1 and active = true returning account_id`;

    logger(`Deactivating audience accounts with audience id: ${audienceId} using query: ${query}`);
    const queryResult = await rdsConnection.updateRecord(query, [audienceId]);
    return queryResult.rows.map((row) => row['account_id']);
};

const extractInsertQueryClause = (recurrentKey, keys) => {
    // eslint-disable-next-line id-length
    const valueIndices = keys.map((_, index) => `($1, $${index + 2})`).join(', ');
    const valueArray = [recurrentKey, ...keys];
    return { valueIndices, valueArray };
};

module.exports.upsertAudienceAccounts = async (audienceId, audienceAccountIdsList) => {
    const { valueIndices, valueArray } = extractInsertQueryClause(audienceId, audienceAccountIdsList);

    const query = `insert into ${config.get('tables.audienceJoinTable')} (audience_id, account_id) ` +
        `values ${valueIndices} on conflict (audience_id, account_id) do update set active = $${valueArray.length + 1}`;

    logger(`Upsert audience accounts with audience id: ${audienceId} using query: ${JSON.stringify(query)}`);
    return rdsConnection.upsertRecords(query, [...valueArray, true]);
};

module.exports.fetchAudience = async (audienceId) => {
    const query = `select * from ${audienceTable} where audience_id = $1`;

    logger(`Fetching full audience info with audience id: ${audienceId} using query: ${JSON.stringify(query)}`);
    const queryResult = await rdsConnection.selectQuery(query, [audienceId]);
    logger('Query result: ', queryResult);

    return queryResult.length > 0 ? camelCaseKeys(queryResult[0]) : null;
};
