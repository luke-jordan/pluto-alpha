'use strict';

const logger = require('debug')('jupiter:audience-selection');
const config = require('config');
const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

class AudienceSelection {

    constructor () {
        this.supportedTables = ['transactions'];
        this.supportedColumns = [
            'transaction_type',
            'settlement_status',
            'responsible_client_id',
            'account_id',
            'creation_time',
            'owner_user_id',
            'count(account_id)'
        ];
    }

    baseCaseQueryBuilder (unit, operatorTranslated) {
        if (!this.supportedColumns.includes(unit.prop)) {
            throw new Error('Property not supported at the moment');
        }

        if (unit.type === 'int') {
            return `${unit.prop}${operatorTranslated}${unit.value}`;
        }

        return `${unit.prop}${operatorTranslated}'${unit.value}'`;
    }

    conditionsFilterBuilder (unit) {
        // base cases
        if (unit.op === 'is') {
            return this.baseCaseQueryBuilder(unit, '=');
        }

        if (unit.op === 'greater_than') {
            return this.baseCaseQueryBuilder(unit, '>');
        }

        if (unit.op === 'greater_than_or_equal_to') {
            return this.baseCaseQueryBuilder(unit, '>=');
        }

        if (unit.op === 'less_than') {
            return this.baseCaseQueryBuilder(unit, '<');
        }

        if (unit.op === 'less_than_or_equal_to') {
            return this.baseCaseQueryBuilder(unit, '<=');
        }

        // end of base cases

        if (unit.op === 'and' && unit.children) {
            return '(' + unit.children.map((innerUnit) => this.conditionsFilterBuilder(innerUnit)).join(' and ') + ')';
        }

        if (unit.op === 'or' && unit.children) {
            return '(' + unit.children.map((innerUnit) => this.conditionsFilterBuilder(innerUnit)).join(' or ') + ')';
        }
    }
    
    extractWhereConditions (selectionJSON) {
        if (selectionJSON.conditions) {
            return selectionJSON.conditions.map((block) => this.conditionsFilterBuilder(block)).join('');
        }
    }

    validateAndParseColumns (columns) {
        return columns.filter((column) => this.supportedColumns.includes(column));
    }

    extractColumnsToCount (selectionJSON) {
        if (selectionJSON.columnsToCount) {
            return this.validateAndParseColumns(selectionJSON.columnsToCount).
                map((filteredColumn) => `count(${filteredColumn})`).
                join(', ');
        }
    }

    extractColumns (selectionJSON) {
        if (selectionJSON.columns) {
            return this.validateAndParseColumns(selectionJSON.columns).join(', ');
        }

        // columns filter not passed, therefore select only `account_id`
        return `account_id`;
    }

    extractTable (selectionJSON) {
        if (!this.supportedTables.includes(selectionJSON.table)) {
            throw new Error('Table not supported at the moment');
        }

        return selectionJSON.table;
    }
    
    extractGroupBy (selectionJSON) {
        if (selectionJSON.groupBy) {
            return this.validateAndParseColumns(selectionJSON.groupBy).join(', ');
        }
    }

    extractHavingFilter (selectionJSON) {
        if (selectionJSON.postConditions) {
            return selectionJSON.postConditions.map((block) => this.conditionsFilterBuilder(block)).join('');
        }
    }

    checkRandomSampleExpectation (selectionJSON) {
        if (selectionJSON.sample && selectionJSON.sample.random) {
            return true;
        }

        return false;
    }

    constructFullQuery (selectionJSON, parsedValues) {
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

        if (whereFilters) {
            mainQuery = `${mainQuery} where ${whereFilters}`;
        }

        if (groupByFilters) {
            mainQuery = `${mainQuery} group by ${groupByFilters}`;
        }

        if (havingFilters) {
            mainQuery = `${mainQuery} having ${havingFilters}`;
        }

        if (this.checkRandomSampleExpectation(selectionJSON)) {
            return `${mainQuery} order by random() limit ${selectionJSON.sample.random}`;
        }

        return mainQuery;
    }

    extractSQLQueryFromJSON (selectionJSON) {
        logger('extracting sql query from JSON: ', selectionJSON);

        const columns = this.extractColumns(selectionJSON);
        const columnsToCount = this.extractColumnsToCount(selectionJSON);
        const table = this.extractTable(selectionJSON);
        const whereFilters = this.extractWhereConditions(selectionJSON);
        const groupByFilters = this.extractGroupBy(selectionJSON);
        const havingFilters = this.extractHavingFilter(selectionJSON);
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
        const fullQuery = this.constructFullQuery(selectionJSON, parsedValues);
        logger('full sql query:', fullQuery);

        return fullQuery;
    }

    async fetchUsersGivenJSON (selectionJSON) {
        try {
            logger('Selecting accounts according to: ', selectionJSON);
            const sqlQuery = this.extractSQLQueryFromJSON(selectionJSON);
            const queryResult = await rdsConnection.selectQuery(sqlQuery);
            logger('Number of records from query: ', queryResult.length);
            return queryResult.map((row) => row['account_id']);
        } catch (error) {
            logger('Error occurred while fetching users given json. Error:', error);
        }
    }
}

module.exports.original = new AudienceSelection();

module.exports.processRequestFromAnotherLambda = async (event) => {
    try {
        const users = await new AudienceSelection().fetchUsersGivenJSON(event);
        logger('Successfully retrieved users', users);
        return {
            statusCode: 200,
            message: users
        };
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return { statusCode: 500, message: error.message };
    }
};
