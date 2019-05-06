'use strict';

const logger = require('debug')('pluto:rds-common:main');
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
     * @option options db The relevant DB for this client (host is common and defined globally)
     * @option options user The user, the remainder of the client assumes this has the  
     */
    constructor(db = 'relevant_db', user = 'postgres_user', password = 'user_password') {
        const self = this;
        self._pool = new Pool({
            host: config.get('db.host'),
            port: config.get('db.port'),
            database: db,
            user: user,
            password: password
        });
        // logger('Set up connection, ready to initiate connections');
    }

    async testPool() {
        const result = await this._pool.query('SELECT 1');
        logger('Connection in place, result of select 1: ', JSON.stringify(result));
        logger('RESULT rows: ', result.rows);
        return result.rows;
    }

    // note: monitor effect on number of open connections as Lambdas multiply, and how exact mechanics of call to layer will work
    async endPool() {
        await this._pool.end();
        logger('Pool has drained');
    }

    async selectQuery(query = 'SELECT * FROM TABLE WHERE VALUE = $1', values = ['VALUE']) {
        if (typeof values === 'undefined') {
            logger('Throwing no values error!');
            throw new NoValuesError(query);
        }

        let results; // since lambda execution means if we return etc., finally may not finish if the return statement is prior to finally
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

    /**
     * 
     * @param {string} queryTemplate The template for the insert query. NOTE: Must include the column list (this is not extracted from the 
     * column template, given flexibility/robustness/time trade-offs), must include 'RETURNING' statement if return wanted, and uses formatting
     * from pg-format to assemble the nested array, i.e., use %L for where the nested array of literals should be inserted
     * @param {string} columnTemplate The template used to assemble the VALUES clause from the object aray, as a list of keys with the
     * format ${column_name}, e.g., '${name}, ${email}, ${account_id}'
     * @param {array} objectArray The array of objects, each having a key that maps to the names in column template. NOTE: Array must be flattened
     */
    async insertRecords(queryTemplate = 'INSERT INTO TABLE (VALUE1, VALUE2) VALUES %L', columnTemplate = '${name}, ${id}', 
                            objectArray = [ { name: 'Test1', id: 'X'}, { name: 'Test2', id: 'Y'}]) {
        const nestedArray = this.compileInsertQueryString(columnTemplate, objectArray);
        // todo : throw an explanatory error here if there is a $1 inside it
        const formattedQuery = format(queryTemplate, nestedArray);

        // const safeSlice = Math.min(10, valuesString.length);
        // logger('About to run insertion, query string: %s, and values: %s', queryTemplate, valuesString.slice(0, safeSlice));
        let results;
        const client = await this._pool.connect();

        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await client.query(formattedQuery);
            await client.query('COMMIT');
        } catch (e) {
            logger('Error running insertion: ', e);
            throw new CommitError(queryTemplate);
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
    async largeMultiTableInsert(inserts = [{ query: 'INSERT QUERIES', columnTemplate: '', rows: [{ }]} ]) {

        let results;

        // we will almost certainly want to upgrade this to do batches of 10k pretty soon
        const client = await this._pool.connect();
        
        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await this._executeMultipleInserts(client, inserts);
            await client.query('COMMIT');
        } catch (e) {
            logger('Error running batch of insertions: ', e);
            throw new CommitError();
        } finally {
            await client.release();
        }

        return results;
    }

    async _executeMultipleInserts(client, inserts) {
        // note : we assume ordering matters, so these should be sequential, so we use a for loop instead of Promise.all
        let results = [];
        for (const insert of inserts) {
            const queryResult = await this._executeQueryInBlock(client, insert['query'], insert['columnTemplate'], insert['rows']);
            results.push(queryResult);
        }
        return results;
    }

    async _executeQueryInBlock(client, query, columnTemplate, rows) {
        const formattedQuery = format(query, this.compileInsertQueryString(columnTemplate, rows));
        const result = await client.query(formattedQuery);
        return result['rows'] && result['rows'].length > 0 ? result['rows'] : [{ completed: true }];
    }

    async updateRecord(query = 'UPDATE TABLE SET VALUE = $1 WHERE ID = $2 RETURNING ID', values = ['UPDATED', 'some-uuid']) {
        if (!values) {
            throw new NoValuesError(query);
        }
        
        let results; // as above
        const client = await this._pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION READ WRITE');
            results = await client.query(query, values);
            await client.query('COMMIT');
        } catch (e) {
            logger('Error running update: ', e);
            throw new CommitError(query, values);
        } finally {
            await client.release();
        }

        return results;
    }

    // todo : _lots_ of error testing
    compileInsertQueryString(columnTemplate, objectArray) {
        const columnNames = this._extractParams(columnTemplate);
        const nestedArray = objectArray.map((object) => columnNames.map((column => object[column])));
        logger(this._formatLogString(columnTemplate, objectArray, nestedArray));
        return nestedArray;
    }

    _extractParams(columnTemplate) {
        const paramRxp = /{([^}]+)}/g;
        const listParams = [];
        let param;
        while (param = paramRxp.exec(columnTemplate)) {
            listParams.push(param[1]);
        }
        return listParams;
    }

    _formatLogString(columnTemplate, objectArray, nestedArray) {
        const sizeSlice = Math.min(2, objectArray.length);
        return `For template ${columnTemplate}, and objects ${JSON.stringify(objectArray.slice(0, sizeSlice))}, have nested array ` + 
            `${JSON.stringify(nestedArray.slice(0, sizeSlice))}`;
    }

}

module.exports = RdsConnection;