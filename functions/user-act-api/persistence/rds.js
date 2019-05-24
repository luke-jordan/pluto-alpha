'use strict';

const logger = require('debug')('pluto:saving:rds');
const config = require('config');
const uuid = require('uuid/v4');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

module.exports.addSavingToTransactions = async (settlementDetails = { 
    'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    'initiationTime': Date.now(),
    'settlementTime': Date.now(),
    'savedAmount': 500,
    'savedCurrency': 'ZAR',
    'savedUnit': 'HUNDREDTH_CENT',
    'prizePoints': 100,
    'offerId': 'id-of-preceding-offer',
    'tags': ['TIME_BASED'],
    'flags': ['RESTRICTED']
}) => {

    // todo : validation
    // const bonusTransactionLedger = config.get('tables.bonus');
    
    let responseEntity;
    try {
        const tableName = config.get('tables.transaction.rds');
        logger('Storing transaction in table: ', tableName);

        const transactionId = uuid();
        const savedUnit = settlementDetails.savedUnit || 'HUNDREDTH_CENT';
        const settlementStatus = !!settlementDetails.settlementTime ? 'SETTLED' : 'PENDING';

        const queryString = `insert into ${tableName} (transaction_id, transaction_type, account_id, currency, unit, amount, settlement_status) ` +
            `values %L returning transaction_id, tags, flags`;
        const columnKeys = '${transactionId}, ${transactionType}, ${accountId}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ${settlementStatus}';
        const rowValues = { 
            transactionId: transactionId, 
            transactionType:  'CREDIT', 
            accountId: settlementDetails['accountId'], 
            savedCurrency: settlementDetails['savedCurrency'] || 'ZAR',
            savedUnit: savedUnit,
            savedAmount: settlementDetails.savedAmount,
            settlementStatus: settlementStatus };
        
        const insertionResult = await rdsConnection.insertRecords(queryString, columnKeys, [rowValues]);
        logger('Result of insert : ', insertionResult);
        responseEntity = insertionResult.rows[0];

        const balanceCount = await exports.sumCurrentBalance(settlementDetails['accountId'], settlementDetails['savedCurrency']);
        logger('New balance count: ', balanceCount);

        responseEntity['newBalance'] = balanceCount['sum'];
    } catch (e) {
        logger('Error inserting save: ', e);
        throw e;
    } 
    
    return responseEntity;
};

module.exports.sumCurrentBalance = async (accountId, currency) => {
    const tableName = config.get('tables.transaction.rds');
    const queryString = `select sum(amount) from ${tableName} where account_id = $1 and currency = $2`;
    const parameters = [accountId, currency];
    logger('Running select query: ', queryString, ', with parameters: ', parameters);
    const rows = await rdsConnection.selectQuery(queryString, parameters);
    logger('Received result: ', rows);
    
    return rows[0];
};
