'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');

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
        whereClause = `((${txTimeClause}) or (${accountTable}.creation_time between $3 and $4)`;
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
