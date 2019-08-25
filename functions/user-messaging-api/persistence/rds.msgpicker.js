'use strict';

const logger = require('debug')('jupiter:message:picker-rds');
const config = require('config');
const moment = require('moment');

const camelcaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const userMessageTable = config.get('tables.userMessagesTable');
const userAccountTable = config.get('tables.accountLedger');

// format: from key into values, e.g., UNIT_MULTIPLIERS[WHOLE_CURRENCY][WHOLE_CENT] = 100;
const UNIT_MULTIPLIERS = {
    'WHOLE_CURRENCY': {
        'HUNDREDTH_CENT': 10000,
        'WHOLE_CENT': 100,
        'WHOLE_CURRENCY': 1
    },
    'WHOLE_CENT': {
        'WHOLE_CURRENCY': 0.01,
        'WHOLE_CENT': 1,
        'HUNDREDTH_CENT': 100
    },
    'HUNDREDTH_CENT': {
        'WHOLE_CURRENCY': 0.0001,
        'WHOLE_CENT': 0.01,
        'HUNDREDTH_CENT': 1
    }
};

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
        `and end_time > current_timestamp and deliveries_done < deliveries_max`;
    const values = [destinationUserId, 'READY_FOR_SENDING'];
    const result = await rdsConnection.selectQuery(query, values);
    logger('Retrieved next message from RDS: ', result);
    return result.map((msg) => transformMsg(msg));
};

const sumOverUnits = (rows, targetUnit = 'HUNDREDTH_CENT') => 
    rows.reduce((sum, row) => sum + row['amount'] * UNIT_MULTIPLIERS[row['unit']][targetUnit], 0);

const accountSumQuery = async (params, systemWideUserId) => {
    const transTypesToInclude = [`'USER_SAVING_EVENT'`, `'ACCRUAL'`, `'CAPITALIZATION'`, `'WITHDRAWAL'`].join(',')
    const query = `select sum(amount), unit from ${userAccountTable} where owner_user_id = $1 and ` +
        `currency = $2 and settlement_status = $3 and transaction_type in ($4) group by unit`;
    const fetchRows = await rdsConnection.selectQuery(query, [systemWideUserId, params.currency, 'SETTLED', transTypesToInclude]);
    logger('Result from select: ', fetchRows);
    return { ...params, amount: sumOverUnits(fetchRows, params.unit) };
};

const interestHistoryQuery = async (params, systemWideUserId) => {
    const transTypesToInclude = [`'ACCRUAL'`, `'CAPITALIZATION'`].join(',');
    const cutOffMoment = moment(params.startTimeMillis, 'x');
    const query = `select sum(amount), unit from ${userAccountTable} where owner_user_id = $1 and ` +
        `currency = $2 and settlement_status = $3 and transaction_type in ($4) and creation_time > $5 group by unit`;
    const values = [systemWideUserId, params.currency, 'SETTLED', transTypesToInclude, cutOffMoment.format()];
    const fetchRows = await rdsConnection.selectQuery(query, values);
    return { ...params, amount: sumOverUnits(fetchRows, params.unit) };
};

const executeAggregateOperation = (operationParams, systemWideUserId) => {
    const operation = operationParams[0];
    switch (operation) {
        case 'balance':
            logger('Calculation a balance of account');
            operationParams = { unit: operationParams[1], currency: operationParams[2] }; 
            return accountSumQuery(operationParams, systemWideUserId);
        case 'interest':
            logger('Calculating interest earned');
            operationParams = { unit: operationParams[1], currency: operationParams[2], startTimeMillis: operationParams[3] };
            return interestHistoryQuery(operationParams, systemWideUserId);
        default:
            return null;
    }
};

// todo :validation, etc.
/**
 * Retrieves figures for the user according to a simple set of instructions, of the form:
 * <variable_of_interest>::<unit>::<currency>(optionally::anything_else_relevant)
 * Currently supported:
 * balance::<unit>::<currency>> : gets the user's balance according to the specified currency
 * interest::<unit>::<currency>>::<sinceEpochMillis>> : adds up the interest capitalized and accrued since the given instant (in millis)
 */
module.exports.getUserAccountFigure = async ({ systemWideUserId, operation }) => {
    logger('User ID: ', systemWideUserId);
    const operationParams = operation.split('::');
    logger('Params for operation: ', operationParams);
    const resultOfOperation = await executeAggregateOperation(operationParams, systemWideUserId);
    logger('Result of operation: ', resultOfOperation);
    if (resultOfOperation) {
        return { amount: resultOfOperation.amount, unit: resultOfOperation.unit, currency: resultOfOperation.currency };
    }
    return undefined;
};


/**
 * Updates a message
 */
module.exports.updateUserMessage = async (messageId, updateValues) => {
    logger('Update message with ID: ', messageId, 'to: ', updateValues);
    const updateDef = {
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