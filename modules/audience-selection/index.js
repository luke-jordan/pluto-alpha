'use strict';

const logger = require('debug')('jupiter:audience-selection');

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

    whereFilterBuilder (unit) {
        // base case
        if (unit.op === 'is') {
            if (!this.supportedColumns.includes(unit.prop)) {
                throw new Error('Property not supported at the moment');
            }

            if (unit.type === 'int') {
                return `${unit.prop}=${unit.value}`;
            }
            return `${unit.prop}='${unit.value}'`;
        }

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
        return `*`;
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

    fetchUsersGivenJSON (selectionJSON) {
        try {
            const columns = this.extractColumns(selectionJSON);
            const columnsToCount = this.extractColumnsToCount(selectionJSON);
            const columnsToFetch = columnsToCount ? `${columns}, ${columnsToCount}` : columns;
            const table = this.extractTable(selectionJSON);
            const whereFilters = this.extractWhereConditions(selectionJSON);
            const groupByFilters = this.extractGroupBy(selectionJSON);
            logger('parsed columns:', columns);
            logger('parsed columns to count:', columnsToCount);
            logger('parsed table:', table);
            logger('where filters:', whereFilters);
            logger('groupBy filters:', groupByFilters);

            const parsedValues = {
                columnsToFetch,
                table,
                whereFilters,
                groupByFilters
            };
            const fullQuery = this.constructFullQuery(selectionJSON, parsedValues);
            logger('full query:', fullQuery);

            return fullQuery;
        } catch (error) {
            logger('Error occurred while fetching users given json. Error:', error);
        }
    }
}

module.exports = new AudienceSelection();
