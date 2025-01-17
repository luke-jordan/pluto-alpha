'use strict';

const logger = require('debug')('jupiter:admin:expiration');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const camelCaseKeys = require('camelcase-keys');
const decamelize = require('decamelize');

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

// reversed order here because most likely to call this with no timestamps
// todo : require client-float on here
module.exports.listAccounts = async ({ specifiedUserIds, includeNoSave, sinceMoment, untilMoment }) => {
    const accountTable = config.get('tables.accountTable');
    const transactionTable = config.get('tables.transactionTable');

    const values = ['USER_SAVING_EVENT'];

    let joinType = 'left join';
    let txTypeSuffix = '';

    if (!includeNoSave) {
        joinType = 'inner join';
        txTypeSuffix = ' and settlement_status = $4';
        values.push('SETTLED');
    }

    let whereClause = '';

    if (specifiedUserIds) {
        whereClause = `where transaction_type = $1 and ${accountTable}.owner_user_id in (${opsUtil.extractArrayIndices(specifiedUserIds, 2)})`;
        values.push(...specifiedUserIds);
    } else {
        whereClause = `where transaction_type = $1 and ${accountTable}.creation_time between $2 and $3${txTypeSuffix}`;
        const start = sinceMoment ? sinceMoment.format() : moment(0).format();
        const end = untilMoment ? untilMoment.format() : moment().format();
        values.push(start, end);
    }
    
    const selectQuery = `select ${accountTable}.account_id, human_ref, ${accountTable}.creation_time, count(transaction_id) from ` + 
            `${accountTable} ${joinType} ${transactionTable} on ${accountTable}.account_id = ${transactionTable}.account_id ` +
            `${whereClause} group by ${accountTable}.account_id`;
            
    logger('Assembled select query: ', selectQuery);
    logger('Assembled select values: ', values);
    const resultOfList = await rdsConnection.selectQuery(selectQuery, values);
    logger('Result of selection: ', resultOfList[0]);
    return resultOfList.map((row) => camelCaseKeys(row));
};

module.exports.getAccountDetails = async (systemWideUserId) => {
    const selectQuery = `select account_id, flags from ${config.get('tables.accountTable')} where owner_user_id = $1`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId]);
    return Array.isArray(resultOfFetch) && resultOfFetch.length > 0 ? camelCaseKeys(resultOfFetch[0]) : [];
};

module.exports.fetchPendingTransactionsForAllUsers = async (startTime, endTime) => {
    logger(`Fetching pending transactions for all users between start time: ${startTime} and end time: ${endTime}`);

    const txTable = config.get('tables.transactionTable');
    const columns = `creation_time, transaction_type, settlement_status, amount, currency, unit, human_reference`;
    
    // ordering is to put withdrawal first
    const fetchQuery = `select ${columns} from ${txTable} where settlement_status = $1 ` +
        `and creation_time > $2 and creation_time <= $3 and transaction_type in ($4, $5) order by transaction_type desc`;
    const values = ['PENDING', startTime, endTime, 'USER_SAVING_EVENT', 'WITHDRAWAL'];
    logger('Sending query to RDS: ', fetchQuery);
    logger('With values: ', values);

    const resultOfQuery = await rdsConnection.selectQuery(fetchQuery, values);

    logger('Result of pending TX query: ', resultOfQuery);

    return camelCaseKeys(resultOfQuery);
};

module.exports.fetchUserPendingTransactions = async (systemWideUserId, startMoment) => {
    logger('Fetching pending transactions for user with ID: ', systemWideUserId);

    const accountTable = config.get('tables.accountTable');
    const txTable = config.get('tables.transactionTable');

    const columns = `transaction_id, ${accountTable}.account_id, ${txTable}.creation_time, transaction_type, settlement_status, ` + 
        `amount, currency, unit, human_reference`;

    const fetchQuery = `select ${columns} from ${accountTable} inner join ${txTable} on ` +
        `${accountTable}.account_id = ${txTable}.account_id where ${accountTable}.owner_user_id = $1 and ` +
        `${txTable}.creation_time > $2 and settlement_status in ($3, $4)`;
    
    const values = [systemWideUserId, startMoment.format(), 'INITIATED', 'PENDING'];

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

module.exports.fetchUserIdsForAccounts = async (accountIds) => {
    const accountTable = config.get('tables.accountTable');

    const query = `select account_id, owner_user_id from ${accountTable} where account_id in (${opsUtil.extractArrayIndices(accountIds)})`;
    const fetchResult = await rdsConnection.selectQuery(query, accountIds);

    return fetchResult.reduce((obj, row) => ({ ...obj, [row['account_id']]: row['owner_user_id'] }), {});
};

module.exports.adjustTxStatus = async ({ transactionId, newTxStatus, logContext }) => {
    logger('Would be logging this context: ', logContext);

    const txTable = config.get('tables.transactionTable');
    const updateQuery = `update ${txTable} set settlement_status = $1 where transaction_id = $2 returning settlement_status, updated_time`;

    logger('Updating transaction status, query: ', updateQuery);
    logger('Updating tx status, values: ', [newTxStatus, transactionId]);
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [newTxStatus, transactionId]);
    logger('Result of transaction update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : null;
};

// todo : validation against prior
module.exports.adjustTxAmount = async ({ transactionId, newAmount }) => {
    logger('Adjusting transaction: ', transactionId, ', with these values: ', newAmount);
    const updateQuery = `update ${config.get('tables.transactionTable')} set amount = $1, unit = $2, currency = $3 ` +
        `where transaction_id = $4 returning amount, unit, currency, updated_time`;
    const updateValues = [newAmount.amount, newAmount.unit, newAmount.currency, transactionId];

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, updateValues);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : null;
};

module.exports.getTransactionDetails = async (transactionId) => {
    const allowedColumns = 'transaction_id, account_id, creation_time, updated_time, transaction_type, settlement_status, settlement_time, client_id, float_id, amount, currency, unit, human_reference, tags, flags';
    const getTxDetailsQuery = `select ${allowedColumns} from ${config.get('tables.transactionTable')} where transaction_id = $1`;
    logger('Finding transaction with query: ', getTxDetailsQuery);
    const transactionFetchRow = await rdsConnection.selectQuery(getTxDetailsQuery, [transactionId]);
    logger('Result of finding transaction details: ', transactionFetchRow);
    return camelCaseKeys(transactionFetchRow[0]);
};

module.exports.countTransactionsBySameAccount = async (transactionId) => {
    const countQuery = `select count(transaction_id) from ${config.get('tables.transactionTable')} where ` +
        `settlement_status = $1 and transaction_type = $2 and account_id = ` +
        `(select account_id from transaction_data.core_transaction_ledger where transaction_id = $3)`;
    
    logger('Counting settled saves with query: ', countQuery);
    const resultOfQuery = await rdsConnection.selectQuery(countQuery, ['SETTLED', 'USER_SAVING_EVENT', transactionId]);
    if (!Array.isArray(resultOfQuery) || resultOfQuery.length === 0 || !resultOfQuery[0]['count']) {
        return 0;
    }

    return parseInt(resultOfQuery[0]['count'], 10);
};

const assembleAccountLog = ({ adminUserId, accountId, logProperties }) => {
    const logObject = {
        logId: uuid(),
        creatingUserId: adminUserId,
        accountId: accountId,
        ...logProperties
    };

    const objectKeys = Object.keys(logObject);
    const columnNames = objectKeys.map((key) => decamelize(key)).join(', ');
    const columnTemplate = objectKeys.map((key) => `\${${key}}`).join(', ');

    const queryTemplate = `insert into ${config.get('tables.accountLogTable')} (${columnNames}) values %L returning creation_time`;

    return { queryTemplate, columnTemplate, rows: [logObject] };
};

module.exports.insertAccountLog = async ({ transactionId, accountId, adminUserId, logType, logContext }) => {
    let relevantAccountId = accountId;
    if (!relevantAccountId) {
        const txDetails = await exports.getTransactionDetails(transactionId);
        relevantAccountId = txDetails.accountId;
    }

    const logProperties = {
        transactionId,
        logType,
        logContext
    };

    const { queryTemplate: insertQuery, columnTemplate, rows: logRows } = 
        assembleAccountLog({ adminUserId, accountId: relevantAccountId, logProperties });
    
    logger('Inserting log object: ', logRows);
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, logRows);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert;
};

module.exports.findUserFromRef = async ({ searchValue, bsheetPrefix }) => {
    // first search
    const normalizedValue = searchValue.trim().toUpperCase();
    
    const firstQuery = `select owner_user_id from ${config.get('tables.accountTable')} where human_ref like $1`;
    const firstSearch = await rdsConnection.selectQuery(firstQuery, [`%${normalizedValue}%`]);
    logger('Result of first account ref search: ', firstSearch);
    if (firstSearch.length > 0) {
        return camelCaseKeys(firstSearch);
    }

    const secondQuery = `select owner_user_id from ${config.get('tables.accountTable')} where $1 = any(tags)`;
    const secondSearch = await rdsConnection.selectQuery(secondQuery, [`${bsheetPrefix}::${normalizedValue}`]);
    logger('Result of second account ref search: ', secondSearch);
    if (secondSearch.length > 0) {
        return camelCaseKeys(secondSearch);
    }

    const thirdQuery = `select owner_user_id from ${config.get('tables.accountTable')} inner join ${config.get('tables.transactionTable')} ` +
        `on ${config.get('tables.accountTable')}.account_id = ${config.get('tables.transactionTable')}.account_id ` +
        `where ${config.get('tables.transactionTable')}.human_reference = $1`;
    const thirdSearch = await rdsConnection.selectQuery(thirdQuery, [normalizedValue]);
    logger('Result of final search: ', thirdSearch);
    if (thirdSearch.length > 0) {
        return camelCaseKeys(thirdSearch);
    }

    return null;
};

module.exports.fetchBsheetTag = async ({ accountId, tagPrefix }) => {
    const selectResult = await rdsConnection.selectQuery(`select tags from ${config.get('tables.accountTable')} where account_id = $1`, [accountId]);
    logger('Got account tags result:', selectResult);

    if (!selectResult || selectResult.length === 0 || !Array.isArray(selectResult[0]['tags']) || selectResult[0]['tags'].length === 0) {
        return null;
    }

    const prefixedTags = selectResult[0]['tags'].filter((tag) => tag.startsWith(`${tagPrefix}::`)); 
    if (prefixedTags.length === 0) {
        return null;
    }

    return prefixedTags[0].split(`${tagPrefix}::`)[1];
};

module.exports.updateBsheetTag = async ({ accountId, tagPrefix, newIdentifier }) => {
    const oldIdentifier = await exports.fetchBsheetTag({ accountId, tagPrefix });

    let arrayOperation = '';
    let updateValues = [];

    if (oldIdentifier) {
        logger('Account has prior identifier, ', oldIdentifier, ' will be just inserting for first time');
        arrayOperation = `array_replace(tags, $1, $2) where account_id = $3`;
        updateValues = [`${tagPrefix}::${oldIdentifier}`, `${tagPrefix}::${newIdentifier}`, accountId];
    } else {
        logger('Account has no prior identifier, will be just inserting for first time');
        arrayOperation = `array_append(tags, $1) where account_id = $2`;
        updateValues = [`${tagPrefix}::${newIdentifier}`, accountId];
    }
    
    const updateQuery = `update ${config.get('tables.accountTable')} set tags = ${arrayOperation} returning owner_user_id, tags`;
    
    logger('Updating balance sheet tag, query: ', updateQuery);
    logger('Updating balance sheet tag, values: ', updateValues);

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, updateValues);

    logger('Result of transaction update: ', resultOfUpdate);

    if (typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows)) {
        const returnedValues = camelCaseKeys(resultOfUpdate.rows[0]);
        return { ...returnedValues, oldIdentifier };
    }

    logger('FATAL_ERROR: User admin balance sheet tag update failed');

    return null;
};

module.exports.getAccountWithFlags = async (systemWideUserId) => {
    const query = `select account_id, flags, tags from ${config.get('tables.accountTable')} where owner_user_id = $1`;
    const queryResult = await rdsConnection.selectQuery(query, [systemWideUserId]);
    if (!Array.isArray(queryResult) || queryResult.length !== 1) { // adjust when switch on multi-account
        throw Error('User has no or multiple accounts');
    }

    return camelCaseKeys(queryResult[0]);
};

module.exports.updateAccountFlags = async ({ accountId, adminUserId, newFlags, oldFlags }) => {
    const accountUpdateDef = {
        table: config.get('tables.accountTable'),
        key: { accountId },
        value: { flags: newFlags },
        returnClause: 'updated_time'
    };
    logger('Assembled update def: ', accountUpdateDef);

    const logProperties = {
        logType: 'ADMIN_UPDATED_FLAGS',
        logContext: { newFlags, oldFlags }
    };

    const accountLogDef = assembleAccountLog({ adminUserId, accountId, logProperties });
    logger('Assembled account log def, updating flags: ', accountLogDef);

    const result = await rdsConnection.multiTableUpdateAndInsert([accountUpdateDef], [accountLogDef]);
    
    return moment(result[0][0]['updated_time']);
};
