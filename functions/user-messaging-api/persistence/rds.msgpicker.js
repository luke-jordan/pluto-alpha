'use strict';

const logger = require('debug')('jupiter:message:picker-rds');
const config = require('config');
const moment = require('moment');

const camelcaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const userMessageTable = config.get('tables.userMessagesTable');

const transformMsg = (msgRawFromRds) => {
    const msgObject = camelcaseKeys(msgRawFromRds);
    // convert timestamps to moments
    msgObject.creationTime = moment(msgObject.creationTime);
    msgObject.startTime = moment(msgObject.startTime);
    msgObject.endTime = moment(msgObject.endTime);
    // remove some unnecessary objects
    const keysToRemove = ['deliveriesDone', 'deliveriesMax', 'destinationUserId', 'flags', 'instructionId', 
            'processedStatus', 'updatedTime'];
    return Object.keys(msgObject).filter((key) => keysToRemove.indexOf(key) === -1).
        reduce((obj, key) => ({ ...obj, [key]: msgObject[key] }), {});
};

module.exports.getNextMessage = async (destinationUserId) => {
    const query = `select * from ${userMessageTable} where destination_user_id = $1 and processed_status = $2 ` + 
        `and end_time > $3 and deliveries_done < deliveries_max`;
    const values = [destinationUserId, 'READY_FOR_SENDING'];
    const result = await rdsConnection.selectQuery(query, values);
    logger('Retrieved next message from RDS: ', result);
    return result.map((msg) => transformMsg(msg));
};

module.exports.getUserAccountFigure = async ({ systemWideUserId, operation }) => {
    logger('User ID: ', systemWideUserId);
    const operationParams = operation.split('::');
    logger('Params for operation: ', operationParams);
    return { amount: 100, currency: 'USD', unit: 'WHOLE_CURRENCY' }
};
