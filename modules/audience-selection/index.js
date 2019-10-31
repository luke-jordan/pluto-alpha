'use strict';

const logger = require('debug')('jupiter:audience-selection');

class AudienceSelection {

    whereFilterBuilder (unit) {
        // base case
        if (unit.op === 'is') {
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

    extractTable (selectionJSON) {
        return `select * from ${selectionJSON.table} where`;
    }

    checkRandomSampleExpectation (queryWithConditions, selectionJSON) {
        if (selectionJSON.sample && selectionJSON.sample.random) {
            return `select * from (${queryWithConditions}) tablesample system(${selectionJSON.sample.random})`;
        }

        return queryWithConditions;
    }

    fetchUsersGivenJSON (selectionJSON) {
        const queryBeginning = this.extractTable(selectionJSON);
        const whereFilters = this.extractWhereConditions(selectionJSON);
        logger('raw whereFilters:', whereFilters);

        const queryWithConditions = `${queryBeginning} ${whereFilters}`;
        logger('query with conditions:', queryWithConditions);

        const fullQuery = this.checkRandomSampleExpectation(queryWithConditions, selectionJSON);
        logger('full query:', fullQuery);

        return fullQuery;
    }
}

module.exports = new AudienceSelection();
