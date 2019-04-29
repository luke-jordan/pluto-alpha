'use strict';

const logger = require('debug')('u:transaction:saving:rds');
const config = require('config');
const uuid = require('uuid/v4');

const { Pool } = require('pg');

const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.database'),
    password: config.get('db.password'),
    port: config.get('db.port')
});

module.exports.addSavingToTransactions = async (settlementDetails = { 
    'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    'initiationTime': Date.now(),
    'settlementTime': Date.now(),
    'savedAmount': 500,
    'savedCurrency': 'ZAR',
    'prizePoints': 100,
    'offerId': 'id-of-preceding-offer',
    'tags': ['TIME_BASED'],
    'flags': ['RESTRICTED']
}) => {

    // const bonusTransactionLedger = config.get('tables.bonus');

    logger('Initiating client connection');
    const client = await pool.connect();
    
    let responseEntity = {};

    try {
        const tableName = config.get('tables.transaction.rds');
        logger('Storing transaction in table: ', tableName);

        await client.query('begin');

        const transactionId = uuid();

        const queryString = `insert into ${tableName} (transaction_id, transaction_type, account_id, currency, amount, settlement_status) ` +
            `values ($1, $2, $3, $4, $5, $6) returning transaction_id, tags, flags`;
        const queryValues = [transactionId, 'CREDIT', settlementDetails['accountId'], settlementDetails['savedCurrency'], 
            settlementDetails['savedAmount'], 'SETTLED'];
        
        const { rows } = await client.query(queryString, queryValues);
        logger('Result of insert : ', rows[0]);

        await client.query('commit');
        responseEntity = rows[0];

        const balanceCount = await exports.sumCurrentBalance(settlementDetails['accountId'], settlementDetails['savedCurrency'], client);
        logger('New balance count: ', balanceCount);

        responseEntity['newBalance'] = balanceCount['sum'];

    } catch (e) {
        await client.query('rollback');
        throw e;
    } finally {
        logger.apply()
        client.release();
    }
    
    return responseEntity;
};

module.exports.sumCurrentBalance = async (accountId, currency, existingDbClient = null) => {
    logger('Initiating or reusing client query to total balance on account');
    
    const client = await (!!existingDbClient ? existingDbClient : pool.connect());
    const tableName = config.get('tables.transaction.rds');
    
    const queryString = `select sum(amount) from ${tableName} where account_id = $1 and currency = $2`;
    const { rows } = await client.query(queryString, [accountId, currency]);
    
    return rows[0];
}