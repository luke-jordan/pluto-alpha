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

module.exports.addOrSubtractFloat = async (floatAdjustmentRequest = {
        clientId: 'some_saving_co', 
        floatId: 'cash_float',
        amount: 100 * 1e4,
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT}) => {
    
    const queryResult = await rdsConnection.selectQuery('select 1', []);
    logger('Query result: ', queryResult);
    
    return queryResult;
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
module.exports.allocateFloat = async(clientId = 'someSavingCo', floatId = 'cashFloat', allocationRequests = [{
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
        't_type': constants.floatTransTypes.ACCRUAL,
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

    return resultOfInsertion;
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
module.exports.allocateToUsers = async(clientId = 'someSavingCo', floatId = 'cashFloat', allocationRequests = [floatUserAccRequest = {
    clientId: 'some_saving_co',
    floatId: 'cash_float',
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
        't_type': constants.floatTransTypes.ACCRUAL,
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
        + `(transaction_id, account_id, transaction_type, settlement_status, amount, currency, unit, float_id, tags) values %L returning transaction_id`;

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
}