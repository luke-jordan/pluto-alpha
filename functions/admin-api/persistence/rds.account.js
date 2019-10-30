'use strict';

const logger = require('debug')('jupiter:admin:expiration');
const config = require('config');
const moment = require('moment');

const camelCaseKeys = require('camelcase-keys');

// note : this will probably create two pools, but that can be managed as this will rarely/ever be called concurrently
const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

/** 
 * Does what it says on the tin -- counts the users with accounts open, where there has been
 * a transaction within the last X days, up until the current
 */
module.exports.countUserIdsWithAccounts = async (sinceMoment, untilMoment, includeNoSave = false) => {
    logger(`Fetching users with accounts open and transactions between ${sinceMoment} and ${untilMoment}`);
    const accountTable = config.get('tables.accountTable');
    const transactionTable = config.get('tables.transactionTable');

    let joinType = '';
    let whereClause = '';
    
    const txTimeClause = `${transactionTable}.creation_time between $3 and $4`; // see below for 1 and 2
    const values = ['USER_SAVING_EVENT', 'SETTLED', sinceMoment.format(), untilMoment.format()];

    if (includeNoSave) {
        joinType = 'left join';
        whereClause = `((${txTimeClause}) or (${accountTable}.creation_time between $3 and $4))`;
    } else {
        joinType = 'inner join';
        whereClause = txTimeClause;
    }

    const countQuery = `select count(distinct(owner_user_id)) from ${accountTable} ${joinType} ${transactionTable} on ` + 
            `${accountTable}.account_id = ${transactionTable}.account_id where transaction_type = $1 and settlement_status = $2 and ` +
            `${whereClause}`;

    logger('Assembled count query: ', countQuery);
    const resultOfCount = await rdsConnection.selectQuery(countQuery, values);
    logger('Result of count: ', resultOfCount);
    return resultOfCount[0]['count'];
};

module.exports.fetchUserPendingTransactions = async (systemWideUserId, startMoment) => {
    logger('Fetching pending transactions for user with ID: ', systemWideUserId);

    const accountTable = config.get('tables.accountTable');
    const txTable = config.get('tables.transactionTable');

    const columns = `transaction_id, ${accountTable}.account_id, ${txTable}.creation_time, transaction_type, settlement_status, ` + 
        `amount, currency, unit, human_reference`;

    const fetchQuery = `select ${columns} from ${accountTable} inner join ${txTable} on ` +
        `${accountTable}.account_id = ${txTable}.account_id where ${accountTable}.owner_user_id = $1 and ` +
        `${txTable}.creation_time > $2 and settlement_status = $3`;
    
    const values = [systemWideUserId, startMoment.format(), 'PENDING'];

    logger('Sending query to RDS: ', fetchQuery);
    logger('With values: ', values);

    const resultOfQuery = await rdsConnection.selectQuery(fetchQuery, values);

    logger('Result of pending TX query: ', resultOfQuery);

    return camelCaseKeys(resultOfQuery);
};

module.exports.expireHangingTransactions = async () => {
    const txTable = config.get('tables.transactionTable');
    const cutOffTime = moment().subtract(config.get('defaults.txExpiry.daysBack'), 'days');

    const updateQuery = `update ${txTable} set settlement_status = $1 where settlement_status in ($2, $3, $4) and ` +
        `creation_time < $5 returning transaction_id, creation_time`;
    const updateValues = ['EXPIRED', 'INITIATED', 'CREATED', 'PENDING', cutOffTime.format()];

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, updateValues);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? resultOfUpdate.rows.map((row) => camelCaseKeys(row)) : [];
};
