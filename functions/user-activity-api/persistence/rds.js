'use strict';

const logger = require('debug')('jupiter:save:rds');
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
    WHOLE_CENT: 100,
    WHOLE_CURRENCY: 100 * 100
};

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

module.exports.fetchTransaction = async (transactionId) => {
    const query = `select * from ${config.get('tables.accountTransactions')} where transaction_id = $1`;
    const row = await rdsConnection.selectQuery(query, [transactionId]);
    return row.length > 0 ? camelizeKeys(row[0]) : null;
};

module.exports.fetchPriorTransactions = async (accountId) => {
    const query = `select * from ${config.get('tables.accountTransactions')} where account_id = $1 ` +
        `and transaction_type in ($2, $3) order by creation_time desc`;
    const rows = await rdsConnection.selectQuery(query, [accountId, 'USER_SAVING_EVENT', 'WITHDRAWAL']);
    return rows.length > 0 ? rows.map((row) => camelizeKeys(row)) : null;
};

// Possibly over-concise, but allows us to sum these on a single query
const sumOverUnits = (rows, targetUnit = 'HUNDREDTH_CENT', amountKey = 'sum') => rows.
    reduce((sum, row) => {
        const rowAmount = parseInt(row[amountKey], 10) * UNIT_MULTIPLIERS[row['unit']][targetUnit]; 
        return sum + rowAmount; 
    }, 0);

// to reinclude later, possibly: and transaction_type in ($4) 
const accountSumQuery = async (params, systemWideUserId) => {
    // const transTypesToInclude = [`'USER_SAVING_EVENT'`, `'ACCRUAL'`, `'CAPITALIZATION'`, `'WITHDRAWAL'`].join(',')
    const userAccountTable = config.get('tables.accountLedger');
    const query = `select sum(amount), unit from ${userAccountTable} inner join ${config.get('tables.accountTransactions')} ` +
        `on ${userAccountTable}.account_id = ${config.get('tables.accountTransactions')}.account_id ` +
        `where owner_user_id = $1 and currency = $2 and settlement_status = $3 group by unit`;
    const fetchRows = await rdsConnection.selectQuery(query, [systemWideUserId, params.currency, 'SETTLED']);
    logger('Result from select: ', fetchRows);
    return { ...params, amount: sumOverUnits(fetchRows, params.unit) };
};

const interestHistoryQuery = async (params, systemWideUserId) => {
    const transTypesToInclude = [`'ACCRUAL'`, `'CAPITALIZATION'`].join(',');
    const userAccountTable = config.get('tables.accountLedger');
    const txTable = config.get('tables.accountTransactions');
    const cutOffMoment = moment(params.startTimeMillis, 'x');
    
    const query = `select sum(amount), unit from ${userAccountTable} inner join ${txTable} ` +
        `on ${userAccountTable}.account_id = ${config.get('tables.accountTransactions')}.account_id ` + 
        `where owner_user_id = $1 and currency = $2 and settlement_status = $3 and transaction_type in ($4) ` +
        `and ${txTable}.creation_time > $5 group by unit`;
    
    const values = [systemWideUserId, params.currency, 'SETTLED', transTypesToInclude, cutOffMoment.format()];
    const fetchRows = await rdsConnection.selectQuery(query, values);
    return { ...params, amount: sumOverUnits(fetchRows, params.unit) };
};

const executeAggregateOperation = (operationParams, systemWideUserId) => {
    const operation = operationParams[0];
    switch (operation) {
        case 'balance': {
            logger('Calculation a balance of account');
            const paramsForPersistence = { unit: operationParams[1], currency: operationParams[2] }; 
            return accountSumQuery(paramsForPersistence, systemWideUserId);
        }
        case 'interest': {
            logger('Calculating interest earned');
            const paramsForPersistence = { unit: operationParams[1], currency: operationParams[2], startTimeMillis: operationParams[3] };
            return interestHistoryQuery(paramsForPersistence, systemWideUserId);
        }
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
    return null;
};

module.exports.countSettledSaves = async (accountId) => {
    const query = `select count(transaction_id) from ${config.get('tables.accountTransactions')} where account_id = $1 and ` +
        `transaction_type = $2 and settlement_status = $3`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [accountId, 'USER_SAVING_EVENT', 'SETTLED']);
    logger('Result of count : ', resultOfQuery);

    if (!Array.isArray(resultOfQuery) || resultOfQuery.length === 0 || !resultOfQuery[0]['count']) {
        return 0;
    }

    return parseInt(resultOfQuery[0]['count'], 10);
};

module.exports.fetchInfoForBankRef = async (accountId) => {
    const accountTable = config.get('tables.accountLedger');
    const txTable = config.get('tables.accountTransactions');
    // note: left join in case this is first save ...
    const query = `select human_ref, count(transaction_id) from ${accountTable} left join ${txTable} ` +
        `on ${accountTable}.account_id = ${txTable}.account_id where ${accountTable}.account_id = $1 group by human_ref`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [accountId]);
    logger('Result of bank info query: ', resultOfQuery);
    return camelizeKeys(resultOfQuery[0]);
};

module.exports.getOwnerInfoForAccount = async (accountId = 'some-account-uid') => {
    const searchQuery = `select owner_user_id, default_float_id, responsible_client_id from ${config.get('tables.accountLedger')} ` +
        `where account_id = $1`;
    logger('Search query: ', searchQuery);
    const resultOfQuery = await rdsConnection.selectQuery(searchQuery, [accountId]);
    return resultOfQuery.length === 0 ? null : {
        systemWideUserId: resultOfQuery[0]['owner_user_id'],
        floatId: resultOfQuery[0]['default_float_id'],
        clientId: resultOfQuery[0]['responsible_client_id']
    };
};

module.exports.findMostCommonCurrency = async (accountId) => {
    const query = `select currency, count(currency) as currency_count from ${config.get('tables.accountTransactions')} where account_id = $1 ` + 
        `group by currency order by currency_count desc limit 1`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [accountId]);
    return resultOfQuery.length > 0 ? resultOfQuery[0]['currency'] : null; 
};

module.exports.findAccountsForUser = async (userId = 'some-user-uid') => {
    const findQuery = `select account_id from ${config.get('tables.accountLedger')} where owner_user_id = $1 order by creation_time desc`;
    const resultOfQuery = await rdsConnection.selectQuery(findQuery, [userId]);
    logger('Result of account find query: ', resultOfQuery);
    return resultOfQuery.map((row) => row['account_id']);
};

module.exports.sumAccountBalance = async (accountId, currency, time = moment()) => {
    const tableToQuery = config.get('tables.accountTransactions');
    
    const findUnitsQuery = `select distinct(unit) from ${tableToQuery} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` + 
        `and creation_time < to_timestamp($3)`;

    const transTypesToInclude = ['USER_SAVING_EVENT', 'ACCRUAL', 'CAPITALIZATION', 'WITHDRAWAL', 'BOOST_REDEMPTION'];
    const preTransParamCount = 5;
    const transTypeIdxs = transTypesToInclude.map((_, idx) => `$${idx + preTransParamCount}`).join(', ');

    const sumQueryForUnit = `select sum(amount), unit from ${tableToQuery} where account_id = $1 and currency = $2 and unit = $3 and ` +
        `settlement_status = 'SETTLED' and creation_time < to_timestamp($4) and transaction_type in (${transTypeIdxs}) group by unit`;

    // logger('Finding units prior to : ', time.format(), ' which is unix timestamp: ', time.unix());
    const params = [accountId, currency, time.unix()];
    logger('Seeking balance with query: ', sumQueryForUnit, ' and params: ', params);

    const unitQueryResult = await rdsConnection.selectQuery(findUnitsQuery, params);
    logger('Result of unit query: ', unitQueryResult);
    const usedUnits = unitQueryResult.map((row) => row.unit);

    const unitQueries = [];
    
    for (let i = 0; i < usedUnits.length; i += 1) {
        const unit = usedUnits[i];
        const sumParams = [accountId, currency, unit, time.unix(), ...transTypesToInclude]; 
        const thisQuery = rdsConnection.selectQuery(sumQueryForUnit, sumParams);
        // logger('Retrieved query: ', thisQuery);
        unitQueries.push(thisQuery);
    }

    const queryResults = await Promise.all(unitQueries);
    logger('Unit query results: ', queryResults);
    // const accountObj = accountTotalResult.reduce((obj, row) => ({ ...obj, [row['allocated_to_id']]: row['sum']}), {}); 
    const unitsWithSums = queryResults.reduce((obj, queryResult) => ({ ...obj, [queryResult[0]['unit']]: queryResult[0]['sum']}), {});

    logger('For units : ', usedUnits, ' result of sums: ', unitsWithSums);

    const totalBalanceInDefaultUnit = Object.keys(unitsWithSums).map((unit) => unitsWithSums[unit] * floatUnitTransforms[unit]).
        reduce((cum, value) => cum + value, 0);
    logger('For account ID, RDS calculation yields result: ', totalBalanceInDefaultUnit);

    // note: try combine with earlier, and/or optimize when these get big
    const findMomentOfLastSettlementQuery = `select creation_time from ${tableToQuery} where account_id = $1 and currency = $2 and settlement_status = 'SETTLED' ` +
        `and creation_time < to_timestamp($3) order by creation_time desc limit 1`;
    const lastTxTimeResult = await rdsConnection.selectQuery(findMomentOfLastSettlementQuery, [accountId, currency, time.unix()]);
    logger('Retrieved last settled time: ', lastTxTimeResult);
    const lastSettledTx = lastTxTimeResult.length > 0 ? lastTxTimeResult[0]['creation_time'] : null;
    const lastTxTime = lastSettledTx ? moment(lastSettledTx) : null; 
    logger('Last settled TX: ', lastSettledTx);

    return { 'amount': totalBalanceInDefaultUnit, 'unit': DEFAULT_UNIT, currency, lastTxTime };
};


/**
 * This function updates a users account tags.
 * @param {string} accountId The users account id.
 * @param {string} tag A tag to be added to thr users account.
 */
module.exports.updateAccountTags = async (systemWideUserId, tag) => {
    const userAccountTable = config.get('tables.accountLedger');
    const updateTagQuery = `update ${userAccountTable} set tags = array_append(tags, $1) where owner_user_id = $2 returning updated_time`;

    const updateTagResult = await rdsConnection.updateRecord(updateTagQuery, [tag, systemWideUserId]);
    logger('Account tags update resulted in:', updateTagResult);

    const updateMoment = moment(updateTagResult['rows'][0]['updated_time']);
    logger('Extracted moment: ', updateMoment);
    return { updatedTime: updateMoment };
};


module.exports.updateTxTags = async (accountId, tag) => {
    const accountTxTable = config.get('tables.accountTransactions');

    const updateQuery = `update ${accountTxTable} set tags = array_append(tags, $1) where account_id = $2 returning updated_time`;

    const updateResult = await rdsConnection.updateRecord(updateQuery, [tag, accountId]);
    logger('Transaction tag update resulted in:', updateResult);

    const updateMoment = moment(updateResult['rows'][0]['updated_time']);
    logger('Extracted moment: ', updateMoment);
    return { updatedTime: updateMoment };
};


module.exports.fetchAccountTagByPrefix = async (accountId, prefix) => {
    const userAccountTable = config.get('tables.accountLedger');
    const selectQuery = `select tags from ${userAccountTable} where account_id = $1`;

    const selectResult = await rdsConnection.selectQuery(selectQuery, [accountId]);
    logger('Got account tags result:', selectResult);

    if (!selectResult || selectResult.length === 0 || !Array.isArray(selectResult[0]['tags']) || selectResult[0]['tags'].length === 0) {
        return null;
    }

    const tags = selectResult[0]['tags'];
    return tags.filter((flag) => flag.includes(`${prefix}::`))[0].split(`${prefix}::`)[1];
};


const assembleAccountTxInsertion = (accountTxId, transactionDetails, floatTxIds) => {
    const accountTxTable = config.get('tables.accountTransactions');
    
    const isTxSettled = transactionDetails.settlementStatus === 'SETTLED';
    const transactionType = transactionDetails.transactionType || 'USER_SAVING_EVENT';
    logger('Is transaction settled? : ', isTxSettled);

    const accountRow = {
        accountTransactionId: accountTxId,
        accountId: transactionDetails.accountId, 
        currency: transactionDetails.currency,
        unit: transactionDetails.unit,
        amount: transactionDetails.amount,
        settlementStatus: transactionDetails.settlementStatus,
        initiationTime: transactionDetails.initiationTime.format(),
        floatId: transactionDetails.floatId,
        clientId: transactionDetails.clientId
    };

    let accountQuery = '';
    let accountColumnKeys = '';

    if (isTxSettled) {
        accountRow.paymentRef = transactionDetails.paymentRef;
        accountRow.paymentProvider = transactionDetails.paymentProvider;
        accountRow.settlementTime = transactionDetails.settlementTime.format();
        accountRow.floatAddTransactionId = floatTxIds.floatAdditionTxId;
        accountRow.floatAllocTransactionId = floatTxIds.floatAllocationTxId;
        
        accountQuery = `insert into ${accountTxTable} (transaction_id, transaction_type, account_id, currency, unit, amount, float_id, client_id, ` +
            `settlement_status, initiation_time, settlement_time, payment_reference, payment_provider, float_adjust_tx_id, float_alloc_tx_id) values %L returning transaction_id, creation_time`;
        // todo : should obviously change syntax in RDS module but that is going to get messy, for now have to leave for later debt clean up
        accountColumnKeys = '${accountTransactionId}, *{' + transactionType + '}, ${accountId}, ${currency}, ${unit}, ${amount}, ' +
            '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}, ${settlementTime}, ${paymentRef}, ${paymentProvider}, ${floatAddTransactionId}, ${floatAllocTransactionId}';

    } else {
        accountQuery = `insert into ${accountTxTable} (transaction_id, transaction_type, account_id, currency, unit, amount, float_id, client_id, ` +
            `settlement_status, initiation_time) values %L returning transaction_id, creation_time`;
        accountColumnKeys = '${accountTransactionId}, *{' + transactionType + '}, ${accountId}, ${currency}, ${unit}, ${amount}, ' +
            '${floatId}, ${clientId}, ${settlementStatus}, ${initiationTime}';
    }

    return {
        query: accountQuery,
        columnTemplate: accountColumnKeys,
        rows: [accountRow]
    };
};

const assembleFloatTxInsertions = (accountTxId, transactionDetails, floatTxIds) => {
    const floatTxTable = config.get('tables.floatTransactions');
    logger('Inserting with Ids: ', floatTxIds);

    // note: we do this as two matching transactions, a save or withdraw (which adds/subtracts the float itself) and then an
    // allocation (including negative allocation) of that amount
    const floatQueryString = `insert into ${floatTxTable} (transaction_id, client_id, float_id, t_type, ` +
        `currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) values %L returning transaction_id, creation_time`;
    const floatColumnKeys = '${floatTransactionId}, ${clientId}, ${floatId}, ${transactionType}, ${currency}, ${unit}, ${amount}, ' + 
        '${allocatedToType}, ${allocatedToId}, ${transactionType}, ${accountTransactionId}';
    
    const rowValuesBase = {
        accountTransactionId: accountTxId,
        accountId: transactionDetails.accountId, 
        currency: transactionDetails.currency,
        unit: transactionDetails.unit,
        amount: transactionDetails.amount,
        floatId: transactionDetails.floatId,
        clientId: transactionDetails.clientId
    };

    const floatAdjustmentRow = JSON.parse(JSON.stringify(rowValuesBase));
    floatAdjustmentRow.transactionType = transactionDetails.transactionType || 'USER_SAVING_EVENT';
    floatAdjustmentRow.floatTransactionId = floatTxIds.floatAdjustmentTxId;
    floatAdjustmentRow.allocatedToType = 'FLOAT_ITSELF';
    floatAdjustmentRow.allocatedToId = transactionDetails.floatId;

    const floatAllocationRow = JSON.parse(JSON.stringify(rowValuesBase));
    floatAllocationRow.transactionType = 'ALLOCATION';
    floatAllocationRow.floatTransactionId = floatTxIds.floatAllocationTxId;
    floatAllocationRow.allocatedToType = 'END_USER_ACCOUNT';
    floatAllocationRow.allocatedToId = transactionDetails.accountId;

    return { 
        query: floatQueryString,
        columnTemplate: floatColumnKeys,
        rows: [
            floatAdjustmentRow,
            floatAllocationRow
        ] 
    };
};

const extractTxDetails = (keyForTransactionId, row) => {
    const obj = { };
    obj[keyForTransactionId] = row['transaction_id'];
    obj['creationTimeEpochMillis'] = moment(row['creation_time']).valueOf();
    return obj;
};

/**
 * Core method. Records a user's saving event, or withdrawal, with three inserts: one, in the accounts table, records the saving event 
 * on the user's account; the second adds the amount of the save to the float; the third allocates a correspdonding amount of the float 
 * to the user. Note that the second and third should only occur (to be fixed below still) when the saving event settles, e.g., if it is still going through the payments
 * system and funds have not yet reflected.
 * @param {string} accountId The ID of the account that is saving
 * @param {Date} initiationTime (Optional) The time when the saving event was initiated by the user
 * @param {Date} settlementTime The time when the saving event settled via payments. If left out, the settlement status is pending
 * @param {amount} amount The amount saved
 * @param {string} currency The currency saved
 * @param {unit} unit The unit of the amount saved
 * @param {string} settlementStatus The status of the saving event (initiated or settled)
 * @param {string} floatId The float to which this amount of saving is allocated
 * @param {string} offerId (Optional) Include if the saving event is clearly linked to a specific inducement/reward
 * @param {string} paymentRef The reference at the payment provider for the transaction
 * @param {string} paymentProvider If settled: who the payment provider was
 * @param {list(string)} tags (Optional) Any tags to include in the event
 * @param {list(string)} flags (Optional) Any flags to add to the event (e.g., if the saving is restricted in withdrawals)
 */
module.exports.addTransactionToAccount = async (transactionDetails) => {
    // todo : validate: settlementTime > initiationTime, settlementStatus = initiated or settled
    const responseEntity = { };
    
    const accountTxId = uuid();

    const floatAdditionTxId = uuid();
    const floatAdjustmentTxId = uuid();

    const isTransactionSettled = transactionDetails.settlementStatus === 'SETTLED';

    const accountQueryDef = assembleAccountTxInsertion(accountTxId, transactionDetails, { floatAdditionTxId, floatAllocationTxId: floatAdjustmentTxId });
    logger('Transaction insert into account tx table defined: ', accountQueryDef);
    
    const queryDefs = [accountQueryDef];
    if (isTransactionSettled) {
        const floatQueryDef = assembleFloatTxInsertions(accountTxId, transactionDetails, { floatAdditionTxId, floatAllocationTxId: floatAdjustmentTxId });
        logger('And with float def: ', floatQueryDef);
        queryDefs.push(floatQueryDef);
    }
    
    const insertionResult = await rdsConnection.largeMultiTableInsert(queryDefs);
    
    logger('Result of insert : ', insertionResult);
    const transactionResults = [
        extractTxDetails('accountTransactionId', insertionResult[0][0])
    ];

    if (isTransactionSettled) {
        transactionResults.push(extractTxDetails('floatAdditionTransactionId', insertionResult[1][0]));
        transactionResults.push(extractTxDetails('floatAllocationTransactionId', insertionResult[1][0]));
    }

    responseEntity['transactionDetails'] = transactionResults;

    if (isTransactionSettled) {
        const balanceCount = await exports.sumAccountBalance(transactionDetails['accountId'], transactionDetails['currency'], moment());
        logger('New balance count: ', balanceCount);
        responseEntity['newBalance'] = { amount: balanceCount.amount, unit: balanceCount.unit };
    }
    
    return responseEntity;
};

/**
 * Second core method. Records that a saving / withdrawal event settled (via any payment intermediary). Payment details includes 
 * provider and reference.
 * @param {string} transactionId The ID of the transaction in the accounts ledger
 * @param {string} paymentProvider The intermediary used for the payment (for tracing, etc.)
 * @param {string} paymentReference The reference for the payment provided by the payment intermediary
 * @param {moment} settlementTime When the payment settled
 */
module.exports.updateTxToSettled = async ({ transactionId, paymentDetails, settlementTime }) => {
    const responseEntity = { };

    const accountTxTable = config.get('tables.accountTransactions');
    
    const floatAdjustmentTxId = uuid();
    const floatAllocationTxId = uuid();

    const pendingTxResult = await rdsConnection.selectQuery(`select * from ${accountTxTable} where transaction_id = $1`, [transactionId]);
    const txDetails = camelizeKeys(pendingTxResult[0]);
    logger('Retrieved pending save: ', txDetails);

    // just in case we get a repeat
    const txAlreadySettled = txDetails.settlementStatus === 'SETTLED' && txDetails.floatAdjustTxId && txDetails.floatAllocTxId;
    if (txAlreadySettled) {
        logger('Already settled, must be direct invoke repeated, return');
        const currBalance = await exports.sumAccountBalance(txDetails['accountId'], txDetails['currency'], moment());
        const existingTxs = { floatAdditionTransactionId: txDetails.floatAdjustTxId, floatAllocationTransactionId: txDetails.floatAllocTxId };
        return { newBalance: currBalance, transactionDetails: existingTxs};
    }

    const updateValue = {
        settlementStatus: 'SETTLED',
        settlementTime: settlementTime.format(),
        floatAdjustTxId: floatAdjustmentTxId,
        floatAllocTxId: floatAllocationTxId          
    };

    if (paymentDetails) {
        updateValue.paymentReference = paymentDetails.paymentRef;
        updateValue.paymentProvider = paymentDetails.paymentProvider;
    }
    
    const updateQueryDef = {
        table: accountTxTable,
        key: { transactionId },
        value: updateValue,
        returnClause: 'transaction_id, account_id, updated_time'
    };

    const floatQueryDef = assembleFloatTxInsertions(transactionId, txDetails, { floatAdjustmentTxId, floatAllocationTxId });
    logger('Assembled float query def: ', floatQueryDef);

    const updateAndInsertResult = await rdsConnection.multiTableUpdateAndInsert([updateQueryDef], [floatQueryDef]);
    logger('Result of update and insert: ', updateAndInsertResult);

    const transactionDetails = [];
    transactionDetails.push({ 
        accountTransactionId: updateAndInsertResult[0][0]['transaction_id'], 
        updatedTimeEpochMillis: moment(updateAndInsertResult[0][0]['updated_time']).valueOf()
    });
    transactionDetails.push(extractTxDetails('floatAdditionTransactionId', updateAndInsertResult[1][0]));
    transactionDetails.push(extractTxDetails('floatAllocationTransactionId', updateAndInsertResult[1][0]));
    responseEntity['transactionDetails'] = transactionDetails;

    logger(`Complete, now getting balance for account ID ${txDetails.accountId} and currency ${txDetails.currency}`);
    const balanceCount = await exports.sumAccountBalance(txDetails['accountId'], txDetails['currency'], moment());
    responseEntity['newBalance'] = { amount: balanceCount.amount, unit: balanceCount.unit, currency: balanceCount.currency };

    return responseEntity;
};

/**
 * Simple quick utility to add important payment parameters 
 * @param {string} transactionId The ID of the transaction
 * @param {string} paymentProvider The third party used for the payment
 * @param {string} paymentRef The machine readable reference from the provider
 * @param {string} bankReference The human readable short bank reference for the payment 
 */
module.exports.addPaymentInfoToTx = async ({ transactionId, paymentProvider, paymentRef, bankRef }) => {
    logger('Adding payment info to TX before returning');

    // persistence stores in more general form, hence key conversion
    const value = {
        paymentProvider,
        paymentReference: paymentRef,
        humanReference: bankRef
    };

    const updateQueryDef = {
        table: config.get('tables.accountTransactions'),
        key: { transactionId },
        value,
        returnClause: 'updated_time'
    };

    const resultOfUpdate = await rdsConnection.updateRecordObject(updateQueryDef);
    logger('Payment info result from RDS: ', resultOfUpdate);

    const updateMoment = moment(resultOfUpdate[0]['updated_time']);
    logger('Extracted moment: ', updateMoment);
    return { updatedTime: updateMoment };
};
