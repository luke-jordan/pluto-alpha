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
    const keysToRemove = ['deliveriesDone', 'deliveriesMax', 'flags', 'instructionId', 'processedStatus', 'updatedTime'];
    return Object.keys(msgObject).filter((key) => keysToRemove.indexOf(key) < 0).
        reduce((obj, key) => ({ ...obj, [key]: msgObject[key] }), {});
};

module.exports.getNextMessage = async (destinationUserId, excludePushNotifications = true) => {
    const values = [destinationUserId, 'READY_FOR_SENDING'];
    
    let pushSuffix = '';
    if (excludePushNotifications) {
        pushSuffix = `and display ->> 'type' != $3`;
        values.push('PUSH');
    }

    const query = `select * from ${userMessageTable} where destination_user_id = $1 and processed_status = $2 ` + 
        `and end_time > current_timestamp and deliveries_done < deliveries_max ${pushSuffix}`;
    
    const result = await rdsConnection.selectQuery(query, values);
    logger('Retrieved next message from RDS: ', result);
    return result.map((msg) => transformMsg(msg));
};

module.exports.getPendingPushMessages = async () => {
    const query = `select * from ${userMessageTable} where processed_status = $1 and end_time > current_timestamp and ` +
        `deliveries_done < deliveries_max and display ->> 'type' = $2`;
    const values = ['READY_FOR_SENDING', 'PUSH'];
    const resultOfQuery = await rdsConnection.selectQuery(query, values);
    return resultOfQuery.map((msg) => transformMsg(msg));
};

// ////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// MESSAGE STATUS HANDLING //////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////

/**
 * Updates a message
 */
module.exports.updateUserMessage = async (messageId, updateValues) => {
    logger('Update message with ID: ', messageId, 'to: ', updateValues);
    const updateDef = {
        table: userMessageTable,
        key: { messageId },
        value: updateValues,
        returnClause: 'message_id, updated_time' 
    };

    const resultOfUpdate = await rdsConnection.multiTableUpdateAndInsert([updateDef], []);
    logger('Update result from RDS: ', resultOfUpdate);

    const resultToReturn = camelcaseKeys(resultOfUpdate[0]);
    resultToReturn.updatedTime = moment(resultToReturn.updatedTime);

    return resultToReturn;
};

/* Batch updates status */
module.exports.bulkUpdateStatus = async (messageIds, newStatus) => {
    const idIndices = messageIds.map((_, idx) => `$${idx + 2}`).join(', ');
    const updateQuery = `update ${userMessageTable} set processed_status = $1 where message_id in (${idIndices})`;
    const values = [newStatus, ...messageIds];
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, values);
    return resultOfUpdate;
};
