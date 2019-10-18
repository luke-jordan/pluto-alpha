'use strict';

const logger = require('debug')('jupiter:account:rds');
const config = require('config');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

// fetch a count of existing accounts with stem of human readable bank ref
module.exports.countHumanRef = async (accountRefStem) => {
    const tableName = config.get('tables.accountData');
    // will need to see how node-psql escaping hadnles this 
    const query = `select count(human_ref) from ${tableName} where human_ref like '$1%'`;
    const countResult = await rdsConnection.selectQuery(query, [accountRefStem]);
    logger('Received from count query: ', countResult);
    return parseInt(countResult[0]['count'], 10);
};

module.exports.insertAccountRecord = async (accountDetails = { 
    accountId: 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    humanRef: 'LJORDAN15',
    clientId: 'zar_savings_co',
    defaultFloatId: 'zar_cash_float',
    ownerUserId: '2c957aca-47f9-4b4d-857f-a3205bfc6a78'}) => {

    const tableName = config.get('tables.accountData');
    logger('Using account table: ', tableName);
    
    const responseEntity = {};
    
    const queryTemplate = `insert into ${tableName} (account_id, human_ref, responsible_client_id, default_float_id, owner_user_id, opening_user_id) ` +
        `values %L returning account_id, creation_time`;
    const columnTemplate = '${accountId}, ${humanRef}, ${clientId}, ${defaultFloatId}, ${ownerUserId}, ${openingUserId}';

    const accountRow = { ...accountDetails };
    accountRow.openingUserId = accountDetails.openingUserId || accountDetails.ownerUserId; // i.e., if none provided, default to owner

    logger('Sending in account row: ', accountRow);
    const insertionResult = await rdsConnection.insertRecords(queryTemplate, columnTemplate, [accountRow]);
    logger('Result of insert : ', insertionResult);
    responseEntity.accountId = insertionResult.rows[0]['account_id'];
    responseEntity.persistedTime = insertionResult.rows[0]['creation_time'];
    
    return responseEntity;
};

// get the account, for now if multiple accounts take most recent
// once actually have instances of multi-account users, put in proper logic
module.exports.getAccountIdForUser = async (systemWideUserId) => {
    const tableName = config.get('tables.accountData');
    const query = `select account_id from ${tableName} where owner_user_id = $1 order by creation_time desc limit 1`;
    const accountRow = await rdsConnection.selectQuery(query, [systemWideUserId]);
    return Array.isArray(accountRow) && accountRow.length > 0 ? accountRow[0]['account_id'] : null;
};
