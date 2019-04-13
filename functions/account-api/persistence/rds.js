'use strict'

const logger = require('debug')('pluto:persistence:rds');
const config = require('config');

const { Pool } = require('pg');

const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.database'),
    password: config.get('db.password'),
    port: config.get('db.port')
});

// logger('Connecting with password: ', config.get('db.password'));

module.exports.insertAccountRecord = async (accountDetails = { 
    'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    'clientId': 'zar_savings_co',
    'userId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78', 
    'userFirstName': 'Luke',
    'userFamilyName': 'Jordan'}) => {

    const tableName = config.get('tables.account.rds');
    logger('Hello this is persistence! Using account table: ', tableName);
    
    const client = await pool.connect();
    
    let responseEntity = {};

    try {
        await client.query('begin');

        const openingUserId = accountDetails['openingUserId'] || accountDetails['ownerUserId'];

        const queryString = `insert into ${tableName} (account_id, responsible_client_id, owner_user_id, opening_user_id, user_first_name, user_last_name) ` +
            `values ($1, $2, $3, $4, $5) returning account_id, tags, flags`;
        const queryValues = [accountDetails['accountId'], accountDetails['clientId'], accountDetails['ownerUserId'], openingUserId, accountDetails['userFirstName'], accountDetails['userFamilyName']];
        
        const { rows } = await client.query(queryString, queryValues);
        logger('Result of insert : ', rows[0]);

        await client.query('commit');
        responseEntity = rows[0];
    } catch (e) {
        await client.query('rollback');
        throw e;
    } finally {
        logger.apply()
        client.release();
    }
    
    return responseEntity;
};