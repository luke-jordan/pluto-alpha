'use strict';

const logger = require('debug')('pluto:account:rds');
const config = require('config');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

module.exports.insertAccountRecord = async (accountDetails = { 
    'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    'clientId': 'zar_savings_co',
    'defaultFloatId': 'zar_cash_float',
    'ownerUserId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78'}) => {

    const tableName = config.get('tables.accountData');
    logger('Using account table: ', tableName);
    
    const responseEntity = {};
    
    const queryTemplate = `insert into ${tableName} (account_id, responsible_client_id, default_float_id, owner_user_id, opening_user_id) ` +
        `values %L returning account_id, creation_time`;
    const columnTemplate = '${accountId}, ${clientId}, ${defaultFloatId}, ${ownerUserId}, ${openingUserId}';

    const accountRow = JSON.parse(JSON.stringify(accountDetails));
    accountRow.openingUserId = accountDetails['openingUserId'] || accountDetails['ownerUserId'];

    const insertionResult = await rdsConnection.insertRecords(queryTemplate, columnTemplate, [accountRow]);
    logger('Result of insert : ', insertionResult);
    responseEntity.accountId = insertionResult.rows[0]['account_id'];
    responseEntity.persistedTime = insertionResult.rows[0]['creation_time'];
    
    return responseEntity;
};
