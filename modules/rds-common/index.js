'use strict';

const logger = require('debug')('pluto:rds-common:main');
const config = require('config');

const { Pool } = require('pg');

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
        logger('Set up connection, ready to initiate connections');
    }

    async testPool() {
        const result = await this._pool.query('SELECT 1');
        logger('Connection in place, result of select 1: ', JSON.stringify(result));
        return result.rows;
    }

    // note: monitor effect on number of open connections as Lambdas multiply, and how exact mechanics of call to layer will work
    async endPool() {
        await this._pool.end();
        logger('Pool has drained');
    }

    async selectQuery(query = 'SELECT * FROM TABLE WHERE VALUE = $1', values = ['VALUE']) {
        const queryResults = await this._pool.query(query, values);
        // logger('Completed running selection, results: ', queryResults);
        return queryResults.rows;
    }

    async insertRecords(queryTemplate = 'INSERT INTO TABLE (VALUE1, VALUE2) VALUES $1', rows = [ { name: 'Test1', id: 'X'}, { name: 'Test2', id: 'Y'}]) {

    }

    async largeMultiTableInsert(insertDefinitions = [{ queryTemplate: 'INSERT QUERIES', rows: [{ }]} ]) {

    }

    async updateRecord(query = 'UPDATE TABLE SET VALUE = $1 WHERE ID = $2', values = ['UPDATED', 'some-uuid']) {

    }

    compileInsertQueryString(template, data) {

    }

}

module.exports = RdsConnection;