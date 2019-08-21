'use strict';

const logger = require('debug')('jupiter:message:picker-rds');
const config = require('config');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const userMessageTable = config.get('tables.userMessagesTable');

module.exports.getNextMessage = async (destinationUserId) => {
    const query = `select * from ${userMessageTable} where user_id = $1 and processed_status = $2 order by priority desc, creation_time asc limit 1`;
    const values = [destinationUserId, 'READY_FOR_SENDING'];
    const result = await rdsConnection.selectQuery(query, values);
    logger('Retrieved next message from RDS: ', result);
    return result;
};

module.exports.getUserAccountFigure = async ({ systemWideUserId, operation }) => {
    logger('User ID: ', systemWideUserId);
    const operationParams = operation.split('::');
    logger('Params for operation: ', operationParams);
    return { amount: 100, currency: 'USD', unit: 'WHOLE_CURRENCY' }
};
