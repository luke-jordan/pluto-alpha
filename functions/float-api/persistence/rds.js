'use strict';

const config = require('config');

const constants = require('../constants');
const logger = require('debug')('pluto:float:rds');
const uuid = require('uuid/v4');

const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'));

const insertionQuery = `insert into ${config.get('tables.floatTransactions')} ` 
        + `(transaction_id, client_id, float_id, t_type, currency, unit, amount, allocated_to_type, allocated_to_id, related_entity_type, related_entity_id) `
        + `values %L returning transaction_id`;

const insertionColumns = '${transaction_id}, ${client_id}, ${float_id}, ${t_type}, ${currency}, ${unit}, ${amount}, ' + 
        '${allocated_to_type}, ${allocated_to_id}, ${related_entity_type}, ${related_entity_id}';

// small utility method to check we're connected, in time expand to print things like pool stats etc
module.exports.debugConnection = async () => {
    const simpleQueryResult = await rdsConnection.selectQuery('select 1', []);
    return simpleQueryResult;
};

module.exports.addOrSubtractFloat = async (request = {
        clientId: 'some_saving_co', 
        floatId: 'cash_float',
        transactionType: constants.floatTransTypes.ACCRUAL,
        amount: 100 * 1e4,
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT,
        backingEntityIdentifer: 'uid-on-wholesale'}) => {
    
    // todo : validation on transaction types

    // const query = `insert into ${config.get('tables.floatTransactions')} (transaction_id, client_id, float_id, t_type, currency, unit, amount, related_entity_type, related_entity_id) `
    //         + `values %L returning transaction_id`;
    const query = insertionQuery;
    const columns = insertionColumns;
    
    const rowToInsert = {
        'transaction_id': request.transactionId || uuid(),
        'client_id': request.clientId,
        'float_id': request.floatId,
        't_type': request.transactionType,
        'currency': request.currency,
        'unit': request.unit,
        'amount': request.amount,
        'allocated_to_type': constants.entityTypes.FLOAT_ITSELF,
        'allocated_to_id' : request.floatId,
        'related_entity_type': request.backingEntityType,
        'related_entity_id': request.backingEntityIdentifier
    };
    
    // todo : we want the timestamp here so we can get precise on the auditing, when calling new balance below
    const queryResult = await rdsConnection.insertRecords(query, columns, [rowToInsert]);
    const queryTxId = queryResult.rows[0]['transaction_id'];
    logger('Query result: ', queryResult);

    const newBalance = await exports.calculateFloatBalance(request.floatId, request.currency);
    logger('New float balance: ', newBalance);

    return {
        updatedBalance: newBalance.balance,
        unit: newBalance.unit,
        transactionId: queryTxId
    };
};

// and add a float totals method

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
module.exports.allocateFloat = async(clientId = 'someSavingCo', floatId = 'cashFloat', allocationRequests = [{
    label: 'BONUS',
    amount: 20 * 1e4,
    currency: 'ZAR',
    unit: constants.floatUnits.DEFAULT,
    allocatedToType: constants.entityTypes.BONUS_POOL,
    allocatedToId: 'someSavingCoBonusPool',
    relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
    relatedEntityId: 'timestampOfAccrualEvent' }]) => {
    
    const mappedArray = allocationRequests.map((request) => ({
        'transaction_id': request.transactionId || uuid(),
        'client_id':  clientId,
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
    const labelledIds = allocationRequests.map((req, index) => {
        return { [req.label || 'id']: resultOfInsertion.rows[index].transaction_id }
    });

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
module.exports.allocateToUsers = async(clientId = 'someSavingCo', floatId = 'cashFloat', allocationRequests = [{
    accountId: 'uid-of-account',
    amount: 10 * 1e4,
    currency: 'ZAR',
    unit: constants.floatUnits.DEFAULT
}]) => {
    // will definitely need to make sure all the account Ids are valid (do as extra test)

    const allocationRows = allocationRequests.map((request) => ({
        'transaction_id': request.floatTxId || uuid(),
        'client_id':  clientId,
        'float_id': floatId,
        't_type': constants.floatTransTypes.ALLOCATION,
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
        columns: insertionColumns,
        rows: allocationRows
    };

    const accountQuery = `insert into ${config.get('tables.accountTransactions')} `
        + `(transaction_id, account_id, transaction_type, settlement_status, amount, currency, unit, float_id, tags) values %L `
        + `returning transaction_id, amount`;

    const accountColumns = '${transaction_id}, ${account_id}, ${transaction_type}, ${settlement_status}, ${amount}, ${currency}, ${unit}, ${float_id}, ${tags}';

    const accountRows = allocationRequests.map((request) => {
        const tags = request.relatedEntityId ? `ARRAY ['${request.relatedEntityType}::${request.relatedEntityId}']` : '{}';
        return {
            'transaction_id': request.accountTxId || uuid(),
            'account_id': request.accountId,
            'transaction_type': 'FLOAT_ALLOCATION',
            'settlement_status': 'ACCRUED',
            'amount': request.amount,
            'currency': request.currency,
            'unit': request.unit,
            'float_id': floatId,
            'tags': tags
        }
    });

    const accountQueryDef = {
        query: accountQuery,
        columns: accountColumns,
        rows: accountRows
    };

    const resultOfDualInsertion = await rdsConnection.largeMultiTableInsert([allocationQueryDef, accountQueryDef]);

    return { result: 'SUCCESS', floatTxIds: resultOfDualInsertion[0], accountTxIds: resultOfDualInsertion[1] };
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
    
    const unitQuery = `select distinct(unit) from ${floatTable} where float_id = $1 and currency = $2 and allocated_to_type = $3`;
    const sumQuery = `select account_id, sum(amount) from ${floatTable} group by account_id where float_id = $1 and ` + 
        `currency = $2 and unit = $3 and allocated_to_type = $4`;

    const unitResults = await rdsConnection.selectQuery(unitQuery, [floatId, currency, entityType]);
    logger('Result of query: ', unitResults);
    // if unit results is empty, then just return an empty object
    if (!unitResults || unitResults.length === 0) {
        logger('No accounts found for float, should probably put something in DLQ');
        return { }; 
    }

    const usedUnits = unitResults.map((row) => row.unit );
    logger('Units used in the float to date: ', usedUnits);
    
    // this could get _very_ big, so using Map for it instead of a simple variable
    const selectResults = new Map();
    
    for (let i=0; i < usedUnits.length; i++) {
        logger('Calculating for unit: ', usedUnits[i]);
        const accountTotalResult = await rdsConnection.selectQuery(sumQuery, [floatId, currency, usedUnits[i], entityType]);
        const accountObj = accountTotalResult.reduce((obj, row) => ({ ...obj, [row['account_id']]: row['sum(amount)']}), {}); 
        
        const transform = constants.floatUnitTransforms[usedUnits[i]];
        logger('Initiating calculation loop');
        Object.keys(accountObj).forEach((accountId) => {
            const priorSum = selectResults.get(accountId) || 0;
            const accountSumInDefaultUnit = accountObj[accountId] * transform; // todo: skip if not present
            selectResults.set(accountId, priorSum + accountSumInDefaultUnit);
        });
        logger('Completed unit calculation');
    }

    logger('Completed calculations of account sums');

    if (logResult) {
        logger(selectResults);
    }
    return selectResults;
};

/**
 * Note: returns -- the amount, in the default unit; what that unit is; details on the earliest transaction that contributed
 * to this balance and is within the date range; the latest such transaction; and what the most common unit is among the float transactions
 * @param {string} floatId The ID of the float whose balance is sought
 * @param {string} currency The float currency sought
 * @param {Date} startDate The date from which to start adding the balance. If not given, defaults to start of time
 * @param {Date} endDate As above, but end date
 */
module.exports.calculateFloatBalance = async function(floatId = 'zar_mmkt_co', currency = 'ZAR', startDate = new Date(0), endDate = new Date()) {
    const floatTable = config.get('tables.floatTransactions');
    const unitQuery = `select distinct(unit) from ${floatTable} where float_id = $1 and currency = $2 `
        + `and allocated_to_type = $3`;
    const unitColumns = [floatId, currency, constants.entityTypes.FLOAT_ITSELF];
    const unitResult = await rdsConnection.selectQuery(unitQuery, unitColumns);

    const usedUnits = unitResult.map((row) => row.unit);
    logger('Units used in float transactions: ', usedUnits);

    let unitsWithSums = { };
    for (let i = 0; i < usedUnits.length; i++) {
        const unit = usedUnits[i];
        logger('Finding balance for unit: ', unit);
        const sumQuery = `select sum(amount) from ${floatTable} where float_id = $1 and currency = $2 and unit = $3 and allocated_to_type = $4 ` +
            `and creation_time between $5 and $6`;
        const sumParams = [floatId, currency, unit, constants.entityTypes.FLOAT_ITSELF, startDate, endDate];
        const sumResult = await rdsConnection.selectQuery(sumQuery, sumParams);
        logger(`Float sum results for unit ${unit}, as : ${JSON.stringify(sumResult)}`);
        unitsWithSums[unit] = sumResult[0]['sum(amount)'];
    }
    logger('Sums for units: ', unitsWithSums);

    const totalBalanceInDefaultUnit = Object.keys(unitsWithSums).map(unit => unitsWithSums[unit] * constants.floatUnitTransforms[unit])
        .reduce((a, b) => a + b, 0);

    // now gather a few pieces of useful information
    const mostCommonUnitQuery = `select unit, count(*) from ${floatTable} group by unit`;
    const unitCounts = await rdsConnection.selectQuery(mostCommonUnitQuery, []);
    logger('Unit counts for this float: ', unitCounts);
    const mostCommonUnit = unitCounts[0]['unit'];
    
    const timeTxQueryStub = `select transaction_id, amount, currency, unit, related_entity_type, related_entity_id `
            + `from ${floatTable} where float_id = $1 and currency = $2 and `;
    const earliestTxRows = await rdsConnection.selectQuery(timeTxQueryStub + `creation_time > $3 order by creation_time asc limit 1`, [floatId, currency, startDate]);
    const latestTxRows = await rdsConnection.selectQuery(timeTxQueryStub + `creation_time < $3 order by creation_time desc limit 1`, [floatId, currency, endDate]);    
    
    return {
        balance: totalBalanceInDefaultUnit,
        unit: constants.floatUnits.DEFAULT,
        earliestTx: earliestTxRows[0],
        latestTx: latestTxRows[0],
        mostCommonUnit: mostCommonUnit
    };
    
}