'use strict';

const logger = require('debug')('jupiter:admin:expiration');
const config = require('config');
const moment = require('moment');

const camelCaseKeys = require('camelcase-keys');

// note : this will probably create two pools, but that can be managed as this will rarely/ever be called concurrently
const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

module.exports.expireHangingTransactions = async () => {
    const txTable = config.get('tables.transactionTable');
    const cutOffTime = moment().subtract(config.get('defaults.txExpiry.daysBack'), 'days');

    const updateQuery = `update ${txTable} set settlement_status = $1 where settlement_status in ($2, $3) and ` +
        `creation_time < $4 returning transaction_id, creation_time`;
    const updateValues = ['EXPIRED', 'CREATED', 'PENDING', cutOffTime.format()];

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, updateValues);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? resultOfUpdate.rows.map((row) => camelCaseKeys(row)) : [];
};
