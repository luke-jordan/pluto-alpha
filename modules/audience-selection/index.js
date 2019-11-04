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
            'owner_user_id'
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

    whereFilterBuilder (unit) {
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
            return '(' + unit.children.map((innerUnit) => this.whereFilterBuilder(innerUnit)).join(' and ') + ')';
        }

        if (unit.op === 'or' && unit.children) {
            return '(' + unit.children.map((innerUnit) => this.whereFilterBuilder(innerUnit)).join(' or ') + ')';
        }
    }
    
    extractWhereConditions (selectionJSON) {
        return selectionJSON.conditions.map((block) => this.whereFilterBuilder(block)).join('');
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

        // columns filter not passed, therefore select all columns
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
            return `group by ${this.validateAndParseColumns(selectionJSON.groupBy)}`;
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
            columnsToFetch,
            table,
            whereFilters,
            groupByFilters
        } = parsedValues;

        let mainQuery = `select ${columnsToFetch} from ${table} where ${whereFilters}`;

        if (groupByFilters) {
            mainQuery = `${mainQuery} ${groupByFilters}`;
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
        const columnsToFetch = columnsToCount ? `${columns}, ${columnsToCount}` : columns;
        const table = this.extractTable(selectionJSON);
        const whereFilters = this.extractWhereConditions(selectionJSON);
        const groupByFilters = this.extractGroupBy(selectionJSON);
        logger('parsed columns:', columns);
        logger('parsed table:', table);
        logger('where filters:', whereFilters);
        logger('parsed columns to count:', columnsToCount);
        logger('groupBy filters:', groupByFilters);

        const parsedValues = {
            columnsToFetch,
            table,
            whereFilters,
            groupByFilters
        };
        const fullQuery = this.constructFullQuery(selectionJSON, parsedValues);
        logger('full sql query:', fullQuery);

        return fullQuery;
    }

    async fetchUsersGivenJSON (selectionJSON) {
        try {
            logger('Selecting accounts according to: ', selectionJSON);
            const sqlQuery = this.extractSQLQueryFromJSON(selectionJSON);
            const queryResult = await rdsConnection.selectFullQuery(sqlQuery);
            logger('Number of records from query: ', queryResult.length);
            return queryResult;
        } catch (error) {
            logger('Error occurred while fetching users given json. Error:', error);
        }
    }
}

module.exports = new AudienceSelection();
