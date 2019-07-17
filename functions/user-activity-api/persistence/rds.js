'use strict';

const logger = require('debug')('pluto:save:rds');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment-timezone');

const camelcase = require('camelcase');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

// NOTE: these are expressed in multiples of the DEFAULT unit, which is hundredth cent (basis point equivalent of currency)
const DEFAULT_UNIT = 'HUNDREDTH_CENT';
const floatUnitTransforms = {
    DEFAULT: 1,
    HUNDREDTH_CENT: 1,
    WHOLE_CENT: 100
};

const camelizeKeys = (object) => Object.keys(object).reduce((o, key) => ({ ...o, [camelcase(key)]: object[key] }), {});

module.exports.findMatchingTransaction = async (txDetails = { 
    accountId: 'some-uuid',
    amount: 100,
    currency: 'ZAR',
    unit: 'HUNDREDTH_CENT',
    cutOffTime: moment() 
}) => {
    // note: we are doing this FIFO (to watch and decide)
    const searchQuery = 'select transaction_id from account_data.core_account_ledger where account_id = $1 and amount = $2 and ' + 
        'currency = $3 and unit = $4 and creation_time < to_timestamp($5) order by creation_time ascending';
    // todo : validation and error throwing
    const resultOfQuery = await rdsConnection.selectQuery(searchQuery, [txDetails.accountId, txDetails.amount, txDetails.currency, 
        txDetails.unit, txDetails.cutOffTime.valueOf()]);
    logger('Result of find transaction query: ', resultOfQuery);
    return resultOfQuery && resultOfQuery.length > 0 ? camelizeKeys(resultOfQuery[0]) : null;
};

module.exports.findClientAndFloatForAccount = async (accountId = 'some-account-uid') => {
    const searchQuery = `select default_float_id, responsible_client_id from ${config.get('tables.accountLedger')} where account_id = $1`;
    logger('Search query: ', searchQuery);
    const resultOfQuery = await rdsConnection.selectQuery(searchQuery, [accountId]);
    return resultOfQuery.length === 0 ? null : {
        floatId: resultOfQuery[0]['default_float_id'],
        clientId: resultOfQuery[0]['responsible_client_id']
    };
};

module.exports.findAccountsForUser = async (userId = 'some-user-uid') => {
    const findQuery = `select account_id from ${config.get('tables.accountLedger')} where owner_user_id = $1 order by creation_time desc`;
    const resultOfQuery = await rdsConnection.selectQuery(findQuery, [userId]);
    logger('Result of account find query: ', resultOfQuery);
    return resultOfQuery.map((row) => row['account_id']);
};

module.exports.sumAccountBalance = async (accountId, currency, time = moment()) => {
    const tableToQuery = config.get('tables.accountTransactions');
    const transTypesToInclude = ["'USER_SAVING_EVENT'", "'ACCRUAL'", "'CAPITALIZATION'", "'WITHDRAWAL'"].join(',');
    
    const findUnitsQuery = `select distinct(unit) from ${tableToQuery} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` + 
        `and creation_time < to_timestamp($3)`;
    const sumQueryForUnit = `select sum(amount), unit from ${tableToQuery} where account_id = $1 and currency = $2 and unit = $3 and settlement_status = 'SETTLED' ` + 
        `and creation_time < to_timestamp($4) and transaction_type in (${transTypesToInclude}) group by unit`;

    logger('Finding units prior to : ', time.format(), ' which is unix timestamp: ', time.unix());
    const params = [accountId, currency, time.unix()];
    logger('Seeking balance with params: ', params);

    const unitQueryResult = await rdsConnection.selectQuery(findUnitsQuery, [accountId, currency, time.unix()]);
    logger('Result of unit query: ', unitQueryResult);
    const usedUnits = unitQueryResult.map((row) => row.unit);

    const unitQueries = [];
    
    for (let i = 0; i < usedUnits.length; i += 1) {
        const unit = usedUnits[i];
        const thisQuery = rdsConnection.selectQuery(sumQueryForUnit, [accountId, currency, unit, time.unix()]);
        logger('Retrieved query: ', thisQuery);
        unitQueries.push(thisQuery);
    }

    const queryResults = await Promise.all(unitQueries);
    logger('Query results: ', queryResults);
    // const accountObj = accountTotalResult.reduce((obj, row) => ({ ...obj, [row['allocated_to_id']]: row['sum']}), {}); 
    const unitsWithSums = queryResults.reduce((obj, queryResult) => ({ ...obj, [queryResult[0]['unit']]: queryResult[0]['sum']}), {});

    logger('For units : ', usedUnits, ' result of sums: ', unitsWithSums);

    const totalBalanceInDefaultUnit = Object.keys(unitsWithSums).map((unit) => unitsWithSums[unit] * floatUnitTransforms[unit]).
        reduce((cum, value) => cum + value, 0);
    logger('For account ID, RDS calculation yields result: ', totalBalanceInDefaultUnit);

    return { 'amount': totalBalanceInDefaultUnit, 'unit': DEFAULT_UNIT };
};

const extractTxDetails = (keyForTransactionId, row) => {
    const obj = { };
    obj[keyForTransactionId] = row['transaction_id'];
    obj['creationTimeEpochMillis'] = moment(row['creation_time']).valueOf();
    return obj;
};

/**
 * Core method. Records a user's saving event, with three inserts: one, in the accounts table, records the saving event on the user's account;
 * the second adds the amount of the save to the float; the third allocates a correspdonding amount of the float to the user. Note that the 
 * second and third should only occur (to be fixed below still) when the saving event settles, e.g., if it is still going through the payments
 * system and funds have not yet reflected.
 * @param {string} accountId The ID of the account that is saving
 * @param {Date} initiationTime (Optional) The time when the saving event was initiated by the user
 * @param {Date} settlementTime The time when the saving event settled via payments. If left out, the settlement status is pending
 * @param {amount} savedAmount The amount saved
 * @param {string} savedCurrency The currency saved
 * @param {unit} savedUnit The unit of the amount saved
 * @param {string} floatId The float to which this amount of saving is allocated
 * @param {string} offerId (Optional) Include if the saving event is clearly linked to a specific inducement/reward
 * @param {list(string)} tags (Optional) Any tags to include in the event
 * @param {list(string)} flags (Optional) Any flags to add to the event (e.g., if the saving is restricted in withdrawals)
 */
module.exports.addSavingToTransactions = async (settlementDetails = { 
    'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
    'initiationTime': Date.now(),
    'settlementTime': Date.now(),
    'savedAmount': 500,
    'savedCurrency': 'ZAR',
    'savedUnit': 'HUNDREDTH_CENT',
    'floatId': 'usd_cash_float',
    'clientId': 'some_client_co',
    'offerId': 'id-of-preceding-offer',
    'tags': ['TIME_BASED'],
    'flags': ['RESTRICTED']
}) => {

    /*
     * todo : validation
     * const bonusTransactionLedger = config.get('tables.bonus');
     */
    
    const responseEntity = { };
    try {
        const accountTxTable = config.get('tables.accountTransactions');
        const floatTxTable = config.get('tables.floatTransactions');
        logger('Storing transaction in table: ', accountTxTable);

        const accountTxId = uuid();
        const floatAdditionTxId = uuid();
        const floatAllocationTxId = uuid();

        const savedUnit = settlementDetails.savedUnit || 'HUNDREDTH_CENT';
        const settlementStatus = settlementDetails.settlementTime ? 'SETTLED' : 'PENDING';

        const accountQueryString = `insert into ${accountTxTable} (transaction_id, transaction_type, account_id, currency, unit, amount, ` +
            `float_id, client_id, settlement_status, initiation_time, settlement_time, payment_reference, float_adjust_tx_id, float_alloc_tx_id) values %L returning transaction_id, creation_time`;
        const accountColumnKeys = '${accountTransactionId}, *{USER_SAVING_EVENT}, ${accountId}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' +
            '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}, ${settlementTime}, ${paymentRef}, ${floatAddTransactionId}, ${floatAllocTransactionId}';

        // note: we do this as two matching transactions, a save (which adds to the float itself) and then an allocation of that amount
        const floatQueryString = `insert into ${floatTxTable} (transaction_id, client_id, float_id, t_type, ` +
            `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;
        const floatColumnKeys = '${floatTransactionId}, ${clientId}, ${floatId}, ${transactionType}, ${savedCurrency}, ${savedUnit}, ${savedAmount}, ' + 
            '${allocatedToType}, ${allocatedToId}, *{USER_SAVING_EVENT}, ${accountTransactionId}';
        
        const rowValuesBase = { 
            accountTransactionId: accountTxId,
            accountId: settlementDetails.accountId, 
            savedCurrency: settlementDetails.savedCurrency,
            savedUnit: savedUnit,
            savedAmount: settlementDetails.savedAmount,
            floatId: settlementDetails.floatId,
            clientId: settlementDetails.clientId,
            settlementStatus: settlementStatus,
            initiationTime: settlementDetails.initiationTime.format(),
            settlementTime: settlementDetails.settlementTime.format()
        };

        const accountRow = JSON.parse(JSON.stringify(rowValuesBase));
        accountRow.paymentRef = settlementDetails.paymentRef;
        accountRow.floatAddTransactionId = floatAdditionTxId;
        accountRow.floatAllocTransactionId = floatAllocationTxId;

        const floatAdditionRow = JSON.parse(JSON.stringify(rowValuesBase));
        floatAdditionRow.transactionType = 'USER_SAVING_EVENT';
        floatAdditionRow.floatTransactionId = floatAdditionTxId;
        floatAdditionRow.allocatedToType = 'FLOAT_ITSELF';
        floatAdditionRow.allocatedToId = settlementDetails.floatId;

        const floatAllocationRow = JSON.parse(JSON.stringify(rowValuesBase));
        floatAllocationRow.transactionType = 'ALLOCATION';
        floatAllocationRow.floatTransactionId = floatAllocationTxId;
        floatAllocationRow.allocatedToType = 'END_USER_ACCOUNT';
        floatAllocationRow.allocatedToId = settlementDetails.accountId;

        const accountQueryDef = { 
            query: accountQueryString,
            columnTemplate: accountColumnKeys,
            rows: [accountRow] 
        };
        const floatQueryDef = { 
            query: floatQueryString,
            columnTemplate: floatColumnKeys,
            rows: [
                floatAdditionRow,
                floatAllocationRow
            ] 
        };
        
        logger('Inserting, with account table def: ', accountQueryDef);
        logger('And with float def: ', floatQueryDef);
        const insertionResult = await rdsConnection.largeMultiTableInsert([accountQueryDef, floatQueryDef]);
        
        logger('Result of insert : ', insertionResult);
        const transactionDetails = [
            extractTxDetails('accountTransactionId', insertionResult[0][0]),
            extractTxDetails('floatAdditionTransactionId', insertionResult[1][0]),
            extractTxDetails('floatAllocationTransactionId', insertionResult[1][0])
        ];

        responseEntity['transactionDetails'] = transactionDetails;

        const balanceCount = await exports.sumAccountBalance(settlementDetails['accountId'], settlementDetails['savedCurrency'], moment());
        logger('New balance count: ', balanceCount);

        responseEntity['newBalance'] = balanceCount;
    } catch (e) {
        logger('Error inserting save: ', e);
        throw e;
    } 
    
    return responseEntity;
};
