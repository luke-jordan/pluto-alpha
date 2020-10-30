'use strict';

const logger = require('debug')('jupiter:save:rds');
const config = require('config');

const moment = require('moment-timezone');
const camelcase = require('camelcase');

const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const camelizeKeys = (object) => Object.keys(object).reduce((o, key) => ({ ...o, [camelcase(key)]: object[key] }), {});

module.exports.fetchTransaction = async (transactionId) => {
    const query = `select * from ${config.get('tables.accountTransactions')} where transaction_id = $1`;
    const row = await rdsConnection.selectQuery(query, [transactionId]);
    return row.length > 0 ? camelizeKeys(row[0]) : null;
};

module.exports.findAccountsForUser = async (userId = 'some-user-uid') => {
    const findQuery = `select account_id from ${config.get('tables.accountLedger')} where owner_user_id = $1 order by creation_time desc`;
    const resultOfQuery = await rdsConnection.selectQuery(findQuery, [userId]);
    logger('Result of account find query: ', resultOfQuery);
    return resultOfQuery.map((row) => row['account_id']);
};

/**
 * Locks a transaction (typically a settled save). Updates settlement status to LOCKED and sets 
 * lock expiry time.
 * @param {object} transactionToLock The transaction to be locked.
 * @param {number} daysToLock The number of days to lock the transaction.
 */
module.exports.lockTransaction = async (transactionId, daysToLock) => {
    const lockedUntilTime = moment().add(daysToLock, 'days').format();

    logger('Locking ID: ', transactionId, ' until: ', lockedUntilTime);
    
    const updateDef = { 
        key: { transactionId },
        value: { settlementStatus: 'LOCKED', lockedUntilTime },
        table: config.get('tables.accountTransactions'),
        returnClause: 'updated_time'
    };

    const resultOfUpdate = await rdsConnection.updateRecordObject(updateDef);
    logger('Result of update: ', resultOfUpdate);

    const updateMoment = resultOfUpdate.length > 0 ? moment(resultOfUpdate[0]['updated_time']) : null;
    logger('Extracted moment: ', updateMoment);
    return { updatedTime: updateMoment };
};

/**
 * This function unlocks locked transactions, setting their status to SETTLED.
 * @param {array} transactionIds An array of transaction ids to be unlocked.
 */
module.exports.unlockTransactions = async (transactionIds) => {
    const updateQuery = `update ${config.get('tables.accountTransactions')} set settlement_status = $1, ` +
        `locked_until_time = null where settlement_status = $2 and locked_until_time < current_timestamp and ` +
        `transaction_id in (${opsUtil.extractArrayIndices(transactionIds, 3)}) returning updated_time, transaction_id`;

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, ['SETTLED', 'LOCKED', ...transactionIds]);
    logger('Result of update: ', resultOfUpdate);

    const updateMoment = resultOfUpdate['rows'].length > 0 ? moment(resultOfUpdate['rows'][0]['updated_time']) : null;
    logger('Extracted moment: ', updateMoment);

    return Array.isArray(resultOfUpdate['rows']) ? resultOfUpdate['rows'].map((result) => result['transaction_id']) : [];
};

/**
 * Fetches transactions with expired locks and the account owners.
 */
module.exports.fetchExpiredLockedTransactions = async () => {
    const accountTxTable = config.get('tables.accountTransactions');
    const accountTable = config.get('tables.accountLedger');

    const query = `select ${accountTxTable}.*, ${accountTable}.owner_user_id from ${accountTxTable} inner join ${accountTable} ` +
        `on ${accountTxTable}.account_id = ${accountTable}.account_id where settlement_status = $1 and ` +
        `locked_until_time is not null and locked_until_time < current_timestamp`;

    const result = await rdsConnection.selectQuery(query, ['LOCKED']);
    logger('Result of expired lock query: ', result);
    
    return result.map((row) => camelizeKeys(row)); 
};
