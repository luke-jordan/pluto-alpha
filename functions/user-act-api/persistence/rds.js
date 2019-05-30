'use strict';

const logger = require('debug')('pluto:save:rds');
const config = require('config');
const uuid = require('uuid/v4');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

module.exports.findMatchingTransaction = async (transactionDetails = { accountId: 'some-uuid', amount: 100, currency: 'ZAR', unit: 'HUNDREDTH_CENT' }) => {

};

module.exports.findFloatForAccount = async (accountId = 'some-account-uid') => {

};

module.exports.addSavingToTransactions = async (settlementDetails = { 
    'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    'initiationTime': Date.now(),
    'settlementTime': Date.now(),
    'savedAmount': 500,
    'savedCurrency': 'ZAR',
    'savedUnit': 'HUNDREDTH_CENT',
    'floatId': 'zar_cash_float',
    'prizePoints': 100,
    'offerId': 'id-of-preceding-offer',
    'tags': ['TIME_BASED'],
    'flags': ['RESTRICTED']
}) => {

    // todo : validation
    // const bonusTransactionLedger = config.get('tables.bonus');
    
    let responseEntity = { };
    try {
        const accountTxTable = config.get('tables.accountTransactions');
        const floatTxTable = config.get('tables.floatTransactions');
        logger('Storing transaction in table: ', accountTxTable);

        const accountTxId = uuid();
        const floatTxId = uuid();

        const savedUnit = settlementDetails.savedUnit || 'HUNDREDTH_CENT';
        const settlementStatus = !!settlementDetails.settlementTime ? 'SETTLED' : 'PENDING';

        const accountQueryString = `insert into ${accountTxTable} (transaction_id, transaction_type, account_id, currency, unit, amount, ` +
            `float_id, matching_float_tx_id, settlement_status) values %L returning transaction_id, tags, flags`;
        const accountColumnKeys = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' +
            '${floatId}, ${floatTransactionId}, ${settlementStatus}';

        const floatQueryString = `insert into ${floatTxTable} (transaction_id, client_id, float_id, t_type, ` +
            `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;
        const floatColumnKeys = '${floatTransactionId}, ${clientId}, ${floatId}, *{SAVING}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' + 
            '*{END_USER_ACCOUNT}, ${accountId}, *{USER_SAVING_EVENT}, ${accountTransactionId}';
        
        const rowValues = { 
            accountTransactionId: accountTxId,
            floatTransactionId: floatTxId, 
            accountId: settlementDetails['accountId'], 
            savedCurrency: settlementDetails['savedCurrency'] || 'ZAR',
            savedUnit: savedUnit,
            savedAmount: settlementDetails.savedAmount,
            floatId: settlementDetails.floatId,
            settlementStatus: settlementStatus 
        };

        const accountQueryDef = { query: accountQueryString, columnTemplate: accountColumnKeys, rows: [rowValues] };
        const floatQueryDef = { query: floatQueryString, columnTemplate: floatColumnKeys, rows: [rowValues] };
        
        logger('Inserting, with account query : ', accountQueryDef);
        logger('And with float def: ', floatQueryDef);
        const insertionResult = await rdsConnection.largeMultiTableInsert([accountQueryDef, floatQueryDef]);
        logger('Result of insert : ', insertionResult);
        responseEntity['transactionDetails'] = insertionResult;

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
    const tableName = config.get('tables.accountTransactions');
    const queryString = `select sum(amount) from ${tableName} where account_id = $1 and currency = $2`;
    const parameters = [accountId, currency];
    logger('Running select query: ', queryString, ', with parameters: ', parameters);
    const rows = await rdsConnection.selectQuery(queryString, parameters);
    logger('Received result: ', rows);
    
    return rows[0];
};
