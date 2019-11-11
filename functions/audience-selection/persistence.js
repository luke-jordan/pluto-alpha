'use strict';

const logger = require('debug')('jupiter:audience-selection:persistence');
const config = require('config');

const uuid = require('uuid/v4');
const decamelize = require('decamelize');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const defaultTable = 'transaction_data.core_transaction_ledger';
const dummyTableForTests = 'transactions';

const supportedTables = [dummyTableForTests, defaultTable];

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
    'distinct(account_id)'
];

const baseCaseQueryBuilder = (unit, operatorTranslated) => {
    if (unit.valueType === 'int' || unit.valueType === 'boolean') {
        return `${unit.prop}${operatorTranslated}${unit.value}`;
    }

    if (operatorTranslated === 'in') {
        return `${unit.prop} ${operatorTranslated} (${unit.value})`;
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

    if (unit.op === 'in') {
        return baseCaseQueryBuilder(unit, 'in');
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

const extractColumns = (selectionJSON) => {
    if (selectionJSON.columns) {
        return validateAndParseColumns(selectionJSON.columns).join(', ');
    }

    // columns filter not passed, therefore select only distinct `account_id`
    return `distinct(account_id)`;
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

// todo : construct version of insert into select in RdsConnection when we protect / validate method-SQL query correspondence
const insertQuery = async (selectionJSON, persistenceParams) => {
    // todo : validation prior to creating the audience
        
    const audienceId = uuid();
    const audienceObject = { 
        audienceId,
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

    const createAudienceDef = {
        queryTemplate: `insert into ${audienceTable} (${audienceColumns}) values %L returning audience_id`,
        columnTemplate: audienceProps.map((prop) => `\${${prop}}`).join(', '),
        objectArray: [audienceObject]
    };

    const audienceResult = await rdsConnection.insertRecords(createAudienceDef);
    logger('Result of inserting bare audience: ', audienceResult);

    // rely on query construction engine to do the insertion query as we need it
    const insertionJSON = { ...selectionJSON };
    insertionJSON.columns = ['distinct(account_id)', audienceId];
    const selectForInsert = exports.extractSQLQueryFromJSON(insertionJSON, persistenceParams);

    // use the compiled selection in the insert query, after converting ID to UUID
    const crossInsertionQuery = `insert into ${audienceJoinTable} (account_id, audience_id) ${selectForInsert}`.
        replace(`'${audienceId}'`, `'${audienceId}'::uuid`);
    logger('Compiled query: ', crossInsertionQuery);

    const joinResult = await rdsConnection.selectQuery(crossInsertionQuery, []);
    logger('Join result: ', joinResult);

    const persistenceResult = {
        audienceId,
        audienceCount: joinResult.length
    };

    return persistenceResult;
};

/**
 * Called right at the end when the column conditions are all in good oder. FOr selection query only, just past the object.
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
    
    logger('Selecting accounts according to: ', selectionJSON);
    const sqlQuery = exports.extractSQLQueryFromJSON(selectionJSON);
    const queryResult = await rdsConnection.selectQuery(sqlQuery, []);
    logger('Number of records from query: ', queryResult.length);
    return queryResult.map((row) => row['account_id']);
};

module.exports.countAudienceSize = async (audienceId, activeOnly = true) => {
    const query = `select count(account_id) from ${audienceJoinTable} where audience_id = $1` + 
        `${activeOnly ? ' and active = true' : ''}`;

    logger('Counting audience size, with query: ', query);
    const resultOfQuery = await rdsConnection.selectQuery(query, [audienceId]);
    logger('Result of audience count: ', resultOfQuery);
    return resultOfQuery[0]['count'];
};

module.exports.selectAudienceActive = async (audienceId, activeOnly = true) => {
    const query = `select account_id from ${audienceJoinTable} where audience_id = $1` +
        `${activeOnly ? ' and active = true' : ''}`;
    
    logger('Retrieving audience with query: ', query);
    const queryResult = await rdsConnection.selectQuery(query, [audienceId]);
    return queryResult.map((row) => row['account_id']);
};
