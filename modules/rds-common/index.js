'use strict';

process.env.SUPPRESS_NO_CONFIG_WARNING = 'y';

const logger = require('debug')('jupiter:rds-common:main');
const config = require('config');

const { Pool } = require('pg');
const format = require('pg-format');

const { QueryError, CommitError, NoValuesError } = require('./errors');

/**
 * This provides wrapping, abstraction, and simplification for interacting with 
 * the primary RDS instance, and for performing bulk inserts and other operations
 * not natively provided by the Node Postgres libraries.
 */

class RdsConnection {

    /**
     * Creates a client to the relevant RDS host and initiates work on it
     * @param {string} db The relevant DB for this client (host is either specified below or global instance is used)
     * @param {string} user The user, the remainder of the client assumes this has the correct permissions
     * @param {string} password Password for the given user
     * @param {string} host Optional. A specified host, otherwise global default for environment is used.
     * @param {number} port Optiona. As above.
     */
    constructor (dbConfigs) {
        const self = this;

        const defaultConfigs = {
            database: 'plutotest', user: 'plutotest', password: 'verylongpassword', host: 'localhost', port: '5432' 
        };
        
        // pattern is nicely explained here: https://github.com/lorenwest/node-config/wiki/Sub-Module-Configuration
        config.util.extendDeep(defaultConfigs, dbConfigs);
        config.util.setModuleDefaults('RdsConnection', defaultConfigs);

        self._pool = new Pool({
            host: config.get('RdsConnection.host'),
            port: config.get('RdsConnection.port'),
            database: config.get('RdsConnection.database'),
            user: config.get('RdsConnection.user'),
            password: config.get('RdsConnection.password')
        });
        logger('Connected with user: ', config.get('RdsConnection.user'));
        // logger('Set up connection, ready to initiate connections');
    }

    async testPool () {
        const result = await this._pool.query('SELECT 1');
        logger('Connection in place, result of select 1: ', JSON.stringify(result));
        logger('RESULT rows: ', result.rows);
        return result.rows;
    }

    // note: monitor effect on number of open connections as Lambdas multiply, and how exact mechanics of call to layer will work
    async endPool () {
        await this._pool.end();
        logger('Pool has drained');
    }

    async selectQuery (query = 'SELECT * FROM TABLE WHERE VALUE = $1', values) {
        if (typeof values === 'undefined') {
            logger('Throwing no values error!');
            throw new NoValuesError(query);
        }

        let results = null; // since lambda execution means if we return etc., finally may not finish if the return statement is prior to finally
        const client = await this._pool.connect();
        try {
            await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
            const queryResult = await client.query(query, values);
            results = queryResult.rows;
        } catch (e) {
            logger('Error in query: ', e);
            throw new QueryError(query, values);
        } finally {
            await client.release();
        }

        return results;
    }

    static _validateInsertParams (queryTemplate, columnTemplate, objectArray) {
        if (!queryTemplate || !columnTemplate || !objectArray) {
            throw new NoValuesError();
        }

        if (typeof queryTemplate !== 'string' || !queryTemplate.includes('%L')) {
            throw new QueryError('Error! Query template must be a string and must include value placeholder (and must be %L, not $1)');
        }

        if (typeof columnTemplate !== 'string' || !columnTemplate.includes('$')) {
            throw new QueryError('Error! Column template must be a string and include value placeholders');
        }

        if (!Array.isArray(objectArray) || objectArray.length === 0) {
            throw new QueryError('Error! Object array must be an array and have length greater than zero');
        }
    }

    /**
     * 
     * @param {string} queryTemplate The template for the insert query. NOTE: Must include the column list (this is not extracted from the 
     * column template, given flexibility/robustness/time trade-offs), must include 'RETURNING' statement if return wanted, and uses formatting
     * from pg-format to assemble the nested array, i.e., use %L for where the nested array of literals should be inserted. Example: 
     * 'INSERT INTO TABLE (VALUE1, VALUE2) VALUES %L'
     * @param {string} columnTemplate The template used to assemble the VALUES clause from the object aray, as a list of keys with the
     * format ${column_name}, e.g., '${name}, ${email}, ${account_id}'
     * @param {array} objectArray The array of objects, each having a key that maps to the names in column template. Example:
     * [ { name: 'Test1', id: 'X'}, { name: 'Test2', id: 'Y'}])
     */
    async insertRecords (queryTemplate, columnTemplate, objectArray) {
        
        RdsConnection._validateInsertParams(queryTemplate, columnTemplate, objectArray);
        
        const nestedArray = RdsConnection.compileInsertQueryString(columnTemplate, objectArray);
        
        // logger('SINGLE: Nested array: ', nestedArray);
        const formattedQuery = format(queryTemplate, nestedArray);
        logger('SINGLE: Formatted query: ', formattedQuery);

        // const safeSlice = Math.min(10, valuesString.length);
        // logger('About to run insertion, query string: %s, and values: %s', queryTemplate, valuesString.slice(0, safeSlice));
        let results = null;
        const client = await this._pool.connect();

        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await client.query(formattedQuery);
            await client.query('COMMIT');
        } catch (e) {
            logger(`RDS error, query: ${queryTemplate}, columnTemplate: ${columnTemplate}, object: ${JSON.stringify(objectArray)}`);
            logger('Error stack: ', e);
            await client.query('ROLLBACK');
            throw new CommitError(queryTemplate, objectArray);
        } finally {
            await client.release();
        }

        logger('Finished running insertion');
        return results;
    }

    /**
     * Note: returns array of arrays, concatenated results if 'returning' clause present, or [{ completed: true }] if none
     * @param {array} insertDefinitions 
     */
    async largeMultiTableInsert (inserts = [{ query: 'INSERT QUERIES', columnTemplate: '', rows: [{ }] }]) {

        let results = null;

        // we will almost certainly want to upgrade this to do batches of 10k pretty soon
        const client = await this._pool.connect();
        
        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await RdsConnection._executeMultipleInserts(client, inserts);
            await client.query('COMMIT');
        } catch (e) {
            logger('Error running batch of insertions: ', e);
            await client.query('ROLLBACK');
            throw new CommitError();
        } finally {
            await client.release();
        }

        return results;
    }

    /**
     * Deletes a row from a table. Must be scarcely used. Must have conditions on it.
     * todo: run a select query first and throw an error if more than one record returned
     * @param {string} tableName The name of the table from which to delete
     * @param {array[string]} conditionColumns An array of the column names to place in the 'where' column. Cannot be empty.
     * @param {array[string]} conditionValues The array of corresponding values for the condition columns 
     */
    async deleteRow (tableName, conditionColumns, conditionValues) {
        if (!conditionColumns || conditionColumns.length === 0 || !conditionValues || conditionValues.length === 0) {
            throw new NoValuesError('Error! Delete row must have condition columns and values');
        }
        
        const queryBase = `DELETE FROM ${tableName} WHERE `;
        const subClauses = conditionColumns.map((column, index) => `(${column} = $${index + 1})`);
        const formedQuery = queryBase.concat(subClauses.join(' AND ')); 

        logger('Formed delete query: ', formedQuery);

        let results = null;
        const client = await this._pool.connect();
        
        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await client.query(formedQuery, conditionValues);
            if (results.rowCount > 1) {
                throw new Error('Error! Trying to delete multiple rows');
            }
            await client.query('COMMIT');
        } catch (e) {
            logger('Error committing delete! : ', e);
            await client.query('ROLLBACK');
            throw new CommitError();
        } finally {
            await client.release();
        }

        logger('Finished, delete result: ', results);
        return results;
    }

    static async _executeMultipleInserts (client, inserts) {
        // note : we assume ordering matters, so these should be sequential, so we use a for loop instead of Promise.all
        const queries = [];
        for (const insert of inserts) {
            queries.push(RdsConnection._executeQueryInBlock(client, insert['query'], insert['columnTemplate'], insert['rows']));
        }
        const results = await Promise.all(queries);
        return results;
    }

    static async _executeQueryInBlock (client, query, columnTemplate, rows) {
        const insertionString = RdsConnection.compileInsertQueryString(columnTemplate, rows);
        const formattedQuery = format(query, insertionString);
        const result = await client.query(formattedQuery);
        return result['rows'] && result['rows'].length > 0 ? result['rows'] : [{ completed: true }];
    }

    async updateRecord (query = 'UPDATE TABLE SET VALUE = $1 WHERE ID = $2 RETURNING ID', values) {
        if (!Array.isArray(values) || values.length === 0) {
            throw new NoValuesError(query);
        }
        
        let results = null;
        const client = await this._pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await client.query(query, values);
            await client.query('COMMIT');
        } catch (e) {
            logger('Error running update: ', e);
            await client.query('ROLLBACK');
            throw new CommitError(query, values);
        } finally {
            await client.release();
        }

        return results;
    }

    // todo : _lots_ of error testing
    static compileInsertQueryString (columnTemplate, objectArray) {
        const paramAndConstantNames = RdsConnection._extractKeysAndConstants(columnTemplate);
        // todo : also security test names for remote code execution
        const nestedArray = objectArray.map((object) => paramAndConstantNames.map((paramOrConstant) => {
            if (paramOrConstant.type === 'PARAM') {
                return object[paramOrConstant['value']];
            }
            return paramOrConstant['value'];
        }));
        
        return nestedArray;
    }

    static _extractKeysAndConstants (columnTemplate) {
        // logger('Template: ', columnTemplate);
        const splitItems = columnTemplate.split(',').map((col) => col.trim());
        // logger('Split items: ', splitItems);
        const paramRegex = /\${([^}]+)}/;
        const constantRegex = /\*{([^}]+)}/;
        const listKeysAndConstants = splitItems.map((item) => {
                if (paramRegex.test(item)) {
                    return { type: 'PARAM', value: paramRegex.exec(item)[1]};
                } else if (constantRegex.test(item)) {
                    return { type: 'CONSTANT', value: constantRegex.exec(item)[1]};
                }
                throw new Error('Bad element in column template');
            });
        return listKeysAndConstants;
    }

    // static _formatLogString (columnTemplate, objectArray, nestedArray) {
    //     const sizeSlice = Math.min(2, objectArray.length);
    //     return `For template ${columnTemplate}, and objects ${JSON.stringify(objectArray.slice(0, sizeSlice))}, have nested array ` + 
    //         `${JSON.stringify(nestedArray.slice(0, sizeSlice))}`;
    // }

}

module.exports = RdsConnection;
