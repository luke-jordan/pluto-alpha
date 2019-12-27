'use strict';

const config = require('config');

const logger = require('debug')('jupiter:float:rds');
const uuid = require('uuid/v4');
const moment = require('moment');

const constants = require('../constants'); // not using config as these are enum type entities
const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const insertionQuery = `insert into ${config.get('tables.floatTransactions')} ` +
        `(transaction_id, client_id, float_id, t_type, currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) ` +
        `values %L returning transaction_id`;

const insertionColumns = '${transaction_id}, ${client_id}, ${float_id}, ${t_type}, ${currency}, ${unit}, ${amount}, ' + 
        '${allocated_to_type}, ${allocated_to_id}, ${related_entity_type}, ${related_entity_id}';

// small utility method to check we're connected, in time expand to print things like pool stats etc
module.exports.debugConnection = async () => {
    const simpleQueryResult = await rdsConnection.selectQuery('select 1', []);
    return simpleQueryResult;
};

/**
 * Adds or removes amounts from the float. Transaction types cannot be allocations. Request dict keys:
 * @param {string} clientId ID for the client company holding the float
 * @param {string} floatId ID of the float to which to add
 * @param {string} transactionType What kind of transaction (e.g., accrual, capitalization, saving, withdrawal)
 * @param {number} amount How much to add or subtract
 * @param {string} currency The currency of the amount
 * @param {string} unit The unit of the amount
 * @param {string} backingEntityType If there is a related backing entity, e.g., an accrual event/transaction, what type is it
 * @param {string} backingEntityIdentifer What is the identifier of the backing endity
 * @param {string} logType The type of float log to record for this
 * @param {number} referenceTimeMillis Optional parameter recording the time the accrual fetch/calc was made, for the log
 */
module.exports.addOrSubtractFloat = async (request = {
        clientId: 'some_saving_co', 
        floatId: 'cash_float',
        transactionType: constants.floatTransTypes.ACCRUAL,
        amount: 100,
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
        backingEntityIdentifer: 'uid-on-wholesale', 
        logType: 'ACCRUAL_EVENT',
        referenceTimeMillis: 0 }) => {
    
    // todo : validation on transaction types, units, log type & reference time, etc.    
    const rowToInsert = {
        'transaction_id': request.transactionId || uuid(),
        'client_id': request.clientId,
        'float_id': request.floatId,
        't_type': request.transactionType,
        'currency': request.currency,
        'unit': request.unit,
        'amount': request.amount,
        'allocated_to_type': constants.entityTypes.FLOAT_ITSELF,
        'allocated_to_id': request.floatId,
        'related_entity_type': request.backingEntityType,
        'related_entity_id': request.backingEntityIdentifier
    };

    const txInsertDef = {
        query: insertionQuery,
        columnTemplate: insertionColumns,
        rows: [rowToInsert]
    };

    const logRefTime = request.referenceTimeMillis ? moment(request.referenceTimeMillis).format() : moment().format();
    const logToInsert = {
        logId: uuid(),
        clientId: request.clientId,
        floatId: request.floatId,
        referenceTime: logRefTime,
        logType: request.logType
    };

    const logInsertQuery = `insert into ${config.get('tables.floatLogs')} (log_id, reference_time, client_id, float_id, log_type) ` +
        `values %L returning log_id, creation_time`;
    const logInsertDef = {
        query: logInsertQuery,
        columnTemplate: '${logId}, ${referenceTime}, ${clientId}, ${floatId}, ${logType}',
        rows: [logToInsert] 
    };
    
    // this is not really large but that is the right method for bundled inserts
    logger('Insert query def: ', logInsertDef);
    logger('And tx def: ', txInsertDef);

    const queryResult = await rdsConnection.largeMultiTableInsert([txInsertDef, logInsertDef]);
    logger('Addition result: ', queryResult);

    // first row of first operation
    const queryTxId = queryResult[0][0]['transaction_id'];
    
    const newBalance = await exports.calculateFloatBalance(request.floatId, request.currency);
    logger('New float balance: ', newBalance);

    return {
        updatedBalance: newBalance.balance,
        unit: newBalance.unit,
        transactionId: queryTxId
    };
};

/**
 * Simple allocation of the float, to either a bonus or company share (do not user this for user accruals)
 * @param {string} clientId The global system ID of the client that intermediates this float 
 * @param {string} floatId The global ID of the float itself
 * @param {number} amount The amount to allocate
 * @param {string} currency The currency of the allocation (for audit purposes)
 * @param {string} unit The unit that the allocation is expressed in (see constants for quasi-enum)
 * @param {string} allocatedToType The type of entity that the allocation is being made to (see constants)
 * @param {string} allocatedToId The ID of that entity (within the ID namespace of that entity type)
 * @param {string} relatedEntityType Optional. Type of the backing or parent entity that spawned this allocation, e.g., the accrual or capitalization event
 * @param {string} relatedEntityId Optional. As above, here the ID (in the relevant namespace) for that entity type
 */
module.exports.allocateFloat = async (clientId = 'someSavingCo', floatId = 'cashFloat', allocationRequests = [{
    label: 'BONUS',
    amount: 100,
    currency: 'ZAR',
    unit: constants.floatUnits.DEFAULT,
    allocatedToType: constants.entityTypes.BONUS_POOL,
    allocatedToId: 'someSavingCoBonusPool',
    relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
    relatedEntityId: 'timestampOfAccrualEvent' }]) => {
    
    const mappedArray = allocationRequests.map((request) => ({
        'transaction_id': request.transactionId || uuid(),
        'client_id': clientId,
        'float_id': floatId,
        't_type': constants.floatTransTypes.ALLOCATION,
        'amount': request.amount,
        'currency': request.currency,
        'unit': request.unit,
        'allocated_to_type': request.allocatedToType,
        'allocated_to_id': request.allocatedToId,
        'related_entity_type': request.relatedEntityType || null,
        'related_entity_id': request.relatedEntityId || null
    }));

    // logger('Calling with values: ', mappedArray);
    const resultOfInsertion = await rdsConnection.insertRecords(insertionQuery, insertionColumns, mappedArray);
    // logger('INSERTION RESULT: ', resultOfInsertion);

    // finally, insert labels if they exist, so caller can map as they want
    const labelledIds = allocationRequests.map((req, index) => ({ [req.label || 'id']: resultOfInsertion.rows[index].transaction_id }));
    // logger('Returning labelledIds: ', labelledIds);

    return labelledIds;
};

/**
 * One of the core methods to the lambda, and to whole system. Takes array of allocations (can be very large), checks, hands them
 * to RDS for a multi-table insert (as needs to go into user account ledger too), and has the result. Note: relies on RDS module
 * to handle performance optimizing (as it should be). Monitor closely over time.
 * @param {string} clientId The global system ID of the client that intermediates this float 
 * @param {string} floatId The global ID of the float which is being allocated
 * @param {array} allocationRequests An array specifying what to allocate to which account, each entry having properties as follows:
 * @param {string} accountId The account to which the amount will be allocated
 * @param {number} amount The amount that will be allocated
 * @param {string} currency The currency involved
 * @param {string} unit The units involved
 * @param {string} relatedEntityType A related entity type (e.g., if recording based on an external accrual tx)
 * @param {string} relatedEntityId The id of the related entity type (if present)
 */
module.exports.allocateToUsers = async (clientId = 'someSavingCo', floatId = 'cashFloat', rawAllocationRequests = [{
    accountId: 'uid-of-account',
    amount: 10000,
    currency: 'ZAR',
    unit: constants.floatUnits.DEFAULT
}]) => {
    // will definitely need to make sure all the account Ids are valid (do as extra test)

    logger(`Running allocation on clientId: ${clientId}, floatId: ${floatId}`);

    const allocationRequests = rawAllocationRequests.map((request) => ({ ...request, floatTxId: request.floatTxId || uuid() }));

    const allocationRows = allocationRequests.map((request) => ({
        'transaction_id': request.floatTxId,
        'client_id': clientId,
        'float_id': floatId,
        't_type': request.allocType || constants.floatTransTypes.ALLOCATION,
        't_state': request.allocState || 'SETTLED', // accounts default to pending, here to settled, because used very differently
        'amount': request.amount,
        'currency': request.currency,
        'unit': request.unit,
        'allocated_to_type': constants.entityTypes.END_USER_ACCOUNT,
        'allocated_to_id': request.accountId,
        'related_entity_type': request.relatedEntityType || null,
        'related_entity_id': request.relatedEntityId || null
    }));

    const allocationQueryDef = {
        query: insertionQuery,
        columnTemplate: insertionColumns,
        rows: allocationRows
    };

    const accountQuery = `insert into ${config.get('tables.accountTransactions')} ` +
        `(transaction_id, account_id, transaction_type, settlement_status, settlement_time, ` + 
        `amount, currency, unit, float_id, client_id, float_alloc_tx_id, tags) values %L ` +
        `returning transaction_id, amount`;

    const accountColumns = '${transaction_id}, ${account_id}, ${transaction_type}, ${settlement_status}, ${settlement_time}, ' + 
        '${amount}, ${currency}, ${unit}, ${float_id}, ${client_id}, ${float_alloc_tx_id}, ${tags}';

    // logger('Allocation request, account IDs: ', allocationRequests.map((request) => request.accountId));

    const accountRows = allocationRequests.map((request) => {
        const tags = request.relatedEntityId ? `ARRAY ['${request.relatedEntityType}::${request.relatedEntityId}']` : '{}';
        const settlementStatus = request.settlementStatus || 'ACCRUED';
        const settlementTime = settlementStatus === 'SETTLED' ? moment().format() : null;
        return {
            'transaction_id': request.accountTxId || uuid(),
            'account_id': request.accountId,
            'transaction_type': request.allocType || 'FLOAT_ALLOCATION',
            'settlement_status': settlementStatus,
            'settlement_time': settlementTime,
            'amount': request.amount,
            'currency': request.currency,
            'unit': request.unit,
            'float_id': floatId,
            'client_id': clientId,
            'float_alloc_tx_id': request.floatTxId,
            'tags': tags
        };
    });

    const accountQueryDef = {
        query: accountQuery,
        columnTemplate: accountColumns,
        rows: accountRows
    };

    const resultOfDualInsertion = await rdsConnection.largeMultiTableInsert([allocationQueryDef, accountQueryDef]);
    logger('Result of allocation records insertion: ', resultOfDualInsertion);

    const floatTxIds = resultOfDualInsertion[0].map((row) => row['transaction_id']);
    const accountTxIds = resultOfDualInsertion[1].map((row) => row['transaction_id']);
    return { result: 'SUCCESS', floatTxIds, accountTxIds };
};

/**
 * Sums up all prior allocations to accounts linked to this float and returns them in in object. Will sum over possible units
 * and will then transform to common base of default unit
 * @param {string} floatId The ID of the float to pull the accrued totals for
 * @param {string} currency The relevant currency
 * @param {constants.entityType} entityType The type of entities to collect (defaults to end user accounts) 
 */
module.exports.obtainAllAccountsWithPriorAllocations = async (floatId, currency, entityType = constants.entityTypes.END_USER_ACCOUNT, logResult = false) => {
    const floatTable = config.get('tables.floatTransactions');
    const accountTable = config.get('tables.openAccounts');
    
    // note : the inner join is necessary just in case something gets into the allocated to IDs that is not an account ID,
    // to prevent later issues with foreign key constraints
    const sumQuery = `select account_id, unit, sum(amount) from ${floatTable} inner join ${accountTable} ` +
        `on ${floatTable}.allocated_to_id = ${accountTable}.account_id::varchar ` + 
        `where float_id = $1 and currency = $2 and allocated_to_type = $3 group by account_id, unit`;
    const queryParams = [floatId, currency, entityType];
    
    logger('Assembled sum query: ', sumQuery);
    logger('And values: ', queryParams);
    
    // this could get _very_ big, so using Map for it instead of a simple variable
    const selectResults = new Map();
    
    // each row in this will have the sum in a particular unit for a particular account
    const accountTotalResults = await rdsConnection.selectQuery(sumQuery, queryParams);
    
    accountTotalResults.forEach((row) => {
        const thisAccountId = row['account_id'];
        const thisAmountInDefault = opsUtil.convertToUnit(parseInt(row['sum'], 10), row['unit'], constants.floatUnits.DEFAULT);
        const priorSum = selectResults.get(thisAccountId) || 0;
        selectResults.set(thisAccountId, priorSum + thisAmountInDefault);
    });
    
    // logger('Completed calculations of account sums, result: ', selectResults);

    if (logResult) {
        logger(selectResults);
    }

    return selectResults;
};

/**
 * Calculates a float balance, optionally only summing transactions within a certain timestamp range.
 * Returns the amount, in the default unit; what that unit is; details on the earliest transaction that contributed
 * to this balance and is within the date range; the latest such transaction; and what the most common unit is among the float transactions
 * @param {string} floatId The ID of the float whose balance is sought
 * @param {string} currency The float currency sought
 * @param {Date} startDate The date from which to start adding the balance. If not given, defaults to start of time
 * @param {Date} endDate As above, but end date
 */
module.exports.calculateFloatBalance = async (floatId = 'zar_mmkt_co', currency = 'ZAR', startDate = new Date(0), endDate = new Date()) => {
    const floatTable = config.get('tables.floatTransactions');
    const unitQuery = `select distinct(unit) from ${floatTable} where float_id = $1 and currency = $2 ` +
        `and allocated_to_type = $3`;
    const unitColumns = [floatId, currency, constants.entityTypes.FLOAT_ITSELF];
    const unitResult = await rdsConnection.selectQuery(unitQuery, unitColumns);

    const usedUnits = unitResult.map((row) => row.unit);
    logger('Units used in float transactions: ', usedUnits);

    const unitQueries = usedUnits.map((unit) => {
        logger('Finding balance for unit: ', unit);
        const sumQuery = `select unit, sum(amount) from ${floatTable} where float_id = $1 and currency = $2 and unit = $3 and allocated_to_type = $4 ` +
            `and creation_time between $5 and $6 group by unit`;
        const sumParams = [floatId, currency, unit, constants.entityTypes.FLOAT_ITSELF, startDate, endDate];
        return rdsConnection.selectQuery(sumQuery, sumParams);
    });

    const unitResults = await Promise.all(unitQueries);
    const unitsWithSums = { };
    unitResults.forEach((result) => { 
        unitsWithSums[result[0]['unit']] = result[0]['sum'];
    });

    logger('Sums for units: ', unitsWithSums);

    const totalBalanceInDefaultUnit = Object.keys(unitsWithSums).map((unit) => unitsWithSums[unit] * constants.floatUnitTransforms[unit]).
        reduce((cum, value) => cum + value, 0);

    // now gather a few pieces of useful information
    const mostCommonUnitQuery = `select unit, count(*) from ${floatTable} group by unit`;
    const unitCounts = await rdsConnection.selectQuery(mostCommonUnitQuery, []);
    logger('Unit counts for this float: ', unitCounts);
    const mostCommonUnit = unitCounts[0]['unit'];
    
    const timeTxQueryStub = `select transaction_id, amount, currency, unit, related_entity_type, related_entity_id ` +
            `from ${floatTable} where float_id = $1 and currency = $2 and`;
    const earliestTxRows = await rdsConnection.selectQuery(`${timeTxQueryStub} creation_time > $3 order by creation_time asc limit 1`, [floatId, currency, startDate]);
    const latestTxRows = await rdsConnection.selectQuery(`${timeTxQueryStub} creation_time < $3 order by creation_time desc limit 1`, [floatId, currency, endDate]);    
    
    // logger('Earliest TX: ', earliestTxRows);
    // logger('Latest TX: ', latestTxRows);

    return {
        balance: totalBalanceInDefaultUnit,
        unit: constants.floatUnits.DEFAULT,
        earliestTx: earliestTxRows[0],
        latestTx: latestTxRows[0],
        mostCommonUnit: mostCommonUnit
    };  
};
