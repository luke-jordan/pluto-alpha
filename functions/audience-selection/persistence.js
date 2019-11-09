'use strict';

const logger = require('debug')('jupiter:audience-selection:persistence');
const config = require('config');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const defaultTable = 'transaction_data.core_transaction_ledger';
const dummyTableForTests = 'transactions';

const supportedTables = [dummyTableForTests, defaultTable];

const HUNDRED_PERCENT = 100;

const supportedColumns = [
    'transaction_type',
    'settlement_status',
    'responsible_client_id',
    'account_id',
    'creation_time',
    'owner_user_id',
    'count(account_id)'
];

const baseCaseQueryBuilder = (unit, operatorTranslated) => {
    if (unit.type === 'int') {
        return `${unit.prop}${operatorTranslated}${unit.value}`;
    }

    return `${unit.prop}${operatorTranslated}'${unit.value}'`;
};

const conditionsFilterBuilder = (unit) => {
    // base cases
    if (unit.op === 'is') {
        return baseCaseQueryBuilder(unit, '=');
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

const validateAndParseColumns = (columns) => {
    return columns.filter((column) => supportedColumns.includes(column));
};

const extractColumnsToCount = (selectionJSON) => {
    if (selectionJSON.columnsToCount) {
        return validateAndParseColumns(selectionJSON.columnsToCount).
            map((filteredColumn) => `count(${filteredColumn})`).
            join(', ');
    }
};

const extractColumns = (selectionJSON) => {
    if (selectionJSON.columns) {
        return validateAndParseColumns(selectionJSON.columns).join(', ');
    }

    // columns filter not passed, therefore select only `account_id`
    return `account_id`;
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
        groupByFilters,
        havingFilters
    } = filters;

    let query = `select count(*) from ${table}`;

    query = addWhereFiltersToQuery(whereFilters, query);
    query = addGroupByFiltersToQuery(groupByFilters, query);
    query = addHavingFiltersToQuery(havingFilters, query);

    const percentageAsFraction = value / HUNDRED_PERCENT;
    return `((${query}) * ${percentageAsFraction})`;
};

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
        table,
        whereFilters,
        groupByFilters,
        havingFilters
    } = parsedValues;

    const columnsToFetch = columnsToCount ? `${columns}, ${columnsToCount}` : columns;

    let mainQuery = `select ${columnsToFetch} from ${table}`;

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

module.exports.extractSQLQueryFromJSON = (selectionJSON) => {
    logger('extracting sql query from JSON: ', selectionJSON);

    const columns = extractColumns(selectionJSON);
    const columnsToCount = extractColumnsToCount(selectionJSON);
    const table = extractTable(selectionJSON);
    const whereFilters = extractWhereConditions(selectionJSON);
    const groupByFilters = extractGroupBy(selectionJSON);
    const havingFilters = extractHavingFilter(selectionJSON);
    logger('parsed columns:', columns);
    logger('parsed table:', table);
    logger('where filters:', whereFilters);
    logger('parsed columns to count:', columnsToCount);
    logger('groupBy filters:', groupByFilters);
    logger('having filters:', havingFilters);

    const parsedValues = {
        columns,
        columnsToCount,
        table,
        whereFilters,
        groupByFilters,
        havingFilters
    };
    const fullQuery = constructFullQuery(selectionJSON, parsedValues);
    logger('full sql query:', fullQuery);

    return fullQuery;
};

/**
 * Called right at the end when the column conditions are all in good oder
 */
module.exports.executeColumnConditions = async (selectionJSON, persistSelection = false) => {
    try {
        logger('Selecting accounts according to: ', selectionJSON);
        const sqlQuery = exports.extractSQLQueryFromJSON(selectionJSON);
        const queryResult = await rdsConnection.selectQuery(sqlQuery, []);
        logger('Number of records from query: ', queryResult.length);
        return queryResult.map((row) => row['account_id']);
    } catch (error) {
        logger('Error occurred while fetching users given json. Error:', error);
    }
};

module.exports.countAudienceSize = (audienceId) => {
    
};

module.exports.selectAudienceActive = (audienceId) => {

};