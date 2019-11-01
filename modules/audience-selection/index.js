'use strict';

const logger = require('debug')('jupiter:audience-selection');

class AudienceSelection {

    constructor () {
        this.supportedTables = ['transactions'];
        this.supportedProperties = ['transaction_type', 'settlement_status', 'creation_time', 'responsible_client_id'];
        this.supportedColumns = ['account_id', 'creation_time'];
    }

    whereFilterBuilder (unit) {
        // base case
        if (unit.op === 'is') {
            if (!this.supportedProperties.includes(unit.prop)) {
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
        return columns.filter((column) => this.supportedColumns.includes(column)).join(', ');
    }

    extractColumns (selectionJSON) {
        if (selectionJSON.columns) {
            return this.validateAndParseColumns(selectionJSON.columns);
        }

        return `*`;
    }

    extractTable (selectionJSON) {
        if (!this.supportedTables.includes(selectionJSON.table)) {
            throw new Error('Table not supported at the moment');
        }

        return selectionJSON.table;
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
            table,
            whereFilters
        } = parsedValues;

        if (this.checkRandomSampleExpectation(selectionJSON)) {
            return `select ${columns} from ${table} where ${whereFilters} order by random() limit ${selectionJSON.sample.random}`;
        }

        return `select ${columns} from ${table} where ${whereFilters}`;
    }

    fetchUsersGivenJSON (selectionJSON) {
        try {
            const columns = this.extractColumns(selectionJSON);
            const table = this.extractTable(selectionJSON);
            const whereFilters = this.extractWhereConditions(selectionJSON);
            logger('parsed columns:', columns);
            logger('parsed table:', table);
            logger('where filters:', whereFilters);

            const parsedValues = {
                columns,
                table,
                whereFilters
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
