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

module.exports.expireBoosts = async () => {
    const boostMasterTable = config.get('tables.boostMasterTable');
    const boostJoinTable = config.get('tables.boostJoinTable');
    
    const updateBoostQuery = `update ${boostMasterTable} set active = $1 where active = true and ` + 
        `end_time < current_timestamp returning boost_id`;
    const updateBoostResult = await rdsConnection.updateRecord(updateBoostQuery, [false]);
    logger('Result of straight update boosts: ', updateBoostResult);
    if (updateBoostResult.rowCount === 0) {
        logger('No boosts expired, can exit');
        return [];
    }

    // note : could do boost_id in above query, but would rather go for a bit of redundancy and slight inneficiency in the
    // query and ensure a bit of robustness, especially in night time batch job. can evaluate again in future
    const updateAccountBoosts = `update ${boostJoinTable} set boost_status = $1 where boost_status not in ($2, $3, $4) and ` +
        `boost_id in (select boost_id from ${boostMasterTable} where active = $5) returning boost_id, account_id`;
    const resultOfUpdate = await rdsConnection.updateRecord(updateAccountBoosts, ['EXPIRED', 'REDEEMED', 'REVOKED', 'EXPIRED', false]);
    logger('Result of updating boost account status: ', resultOfUpdate);

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

module.exports.insertAccountLog = async ({ transactionId, accountId, adminUserId, logType, logContext }) => {
    let relevantAccountId = accountId;
    if (!relevantAccountId) {
        const getIdQuery = `select account_id from ${config.get('tables.transactionTable')} where transaction_id = $1`;
        logger('Finding account ID with query: ', getIdQuery);
        const accountIdFetchRow = await rdsConnection.selectQuery(getIdQuery, [transactionId]);
        logger('Result of finding account ID: ', accountIdFetchRow);
        relevantAccountId = accountIdFetchRow[0]['account_id'];
    }

    const logObject = {
        logId: uuid(),
        creatingUserId: adminUserId,
        accountId: relevantAccountId,
        transactionId,
        logType,
        logContext
    };

    const objectKeys = Object.keys(logObject);
    const columnNames = objectKeys.map((key) => decamelize(key)).join(', ');
    const columnTemplate = objectKeys.map((key) => `\${${key}}`).join(', ');

    const insertQuery = `insert into ${config.get('tables.accountLogTable')} (${columnNames}) values %L returning creation_time`;
    
    logger('Inserting log object: ', logObject);
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [logObject]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert;
};

// we use this to find accounts by either bank reference or balance sheet (FinWorks) reference
module.exports.findUserFromRef = async ({ searchValue, bsheetPrefix }) => {
    // first search
    const normalizedValue = searchValue.trim().toUpperCase();
    const firstQuery = `select owner_user_id from ${config.get('tables.accountTable')} where human_ref = $1`;
    const firstSearch = await rdsConnection.selectQuery(firstQuery, [normalizedValue]);
    logger('Result of first account ref search: ', firstSearch);
    if (firstSearch.length > 0) {
        return firstSearch[0]['owner_user_id'];
    }

    const secondQuery = `select owner_user_id from ${config.get('tables.accountTable')} where $1 = any(tags)`;
    const secondSearch = await rdsConnection.selectQuery(secondQuery, [`${bsheetPrefix}::${normalizedValue}`]);
    logger('Result of second account ref search: ', secondSearch);
    if (secondSearch.length > 0) {
        return secondSearch[0]['owner_user_id'];
    }

    const thirdQuery = `select owner_user_id from ${config.get('tables.accountTable')} inner join ${config.get('tables.transactionTable')} ` +
        `on ${config.get('tables.accountTable')}.account_id = ${config.get('tables.transactionTable')}.account_id ` +
        `where ${config.get('tables.transactionTable')}.human_reference = $1`;
    const thirdSearch = await rdsConnection.selectQuery(thirdQuery, [normalizedValue]);
    logger('Result of final search: ', thirdSearch);
    if (thirdSearch.length > 0) {
        return thirdSearch[0]['owner_user_id'];
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
