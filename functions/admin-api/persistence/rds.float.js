'use strict';

const logger = require('debug')('jupiter:admin:rds-float');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const opsUtil = require('ops-util-common');
const camelcaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const defaultUnit = 'HUNDREDTH_CENT';

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const aggregateFloatTotals = (resultRows) => {
    const floatResultMap = new Map();
    
    resultRows.forEach((row) => {
        const thisFloatId = row['float_id'];
        const thisCurrency = row['currency'];

        const existingSum = floatResultMap.get(thisFloatId);
        const floatSumDict = typeof existingSum === 'undefined' ? {} : { ...existingSum };
        
        const currencySum = Reflect.has(floatSumDict, thisCurrency) ? floatSumDict[thisCurrency] : { 'amount': 0, 'unit': defaultUnit};

        const sumForThisUnit = parseInt(row['sum'], 10);
        const thisUnit = row['unit'];
        const thisAmountInDefaultUnit = opsUtil.convertToUnit(sumForThisUnit, thisUnit, defaultUnit);

        logger(`For float ${thisFloatId}, in ${thisCurrency}, converted ${sumForThisUnit} from unit ${thisUnit}, to become ${thisAmountInDefaultUnit}`);

        currencySum.amount += thisAmountInDefaultUnit;
        floatSumDict[thisCurrency] = currencySum;

        floatResultMap.set(thisFloatId, floatSumDict);
    });

    logger('Returning float result: ', floatResultMap);
    return floatResultMap;
};

module.exports.getFloatBalanceAndFlows = async (floatIds, startTime, endTime) => {
    logger('Fetching balance for floats: ', floatIds);

    const floatTxTable = config.get('tables.floatTxTable');
    
    const nonFloatIdArgs = 4;
    const floatIndices = extractArrayIndices(floatIds, nonFloatIdArgs + 1);

    const start = startTime ? startTime.format() : moment(0).format();
    const end = endTime ? endTime.format() : moment().format();
    
    const sumQuery = `select float_id, currency, unit, sum(amount) from ${floatTxTable} where allocated_to_type = $1 ` +
        `and t_state = $2 and creation_time between $3 and $4 and float_id in (${floatIndices}) group by float_id, currency, unit`;
    
    const queryValues = ['FLOAT_ITSELF', 'SETTLED', start, end, ...floatIds];
    logger('Executing query: ', sumQuery, ', with values: ', queryValues);
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);
    
    return aggregateFloatTotals(queryResult);
};

module.exports.getFloatAllocatedTotal = async (clientId, floatId, startTime, endTime) => {
    logger('Obtaining allocated totals for floats: ', floatId);

    const floatTxTable = config.get('tables.floatTxTable');
    
    const start = startTime ? startTime.format() : moment(0).format();
    const end = endTime ? endTime.format() : moment().format();

    const sumQuery = `select float_id, currency, unit, sum(amount) from ${floatTxTable} where ` +
        `allocated_to_type != $1 and t_state = $2 and creation_time between $3 and $4 and client_id = $5 and float_id = $6 ` +
        `group by float_id, currency, unit`;
    
    const queryValues = ['FLOAT_ITSELF', 'SETTLED', start, end, clientId, floatId];

    logger('Float allocation total, executing query: ', sumQuery);
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);
    
    const floatTotal = aggregateFloatTotals(queryResult);
    return floatTotal.get(floatId);
};

// this is more occasional, so not bunching/grouping float IDs, at least until get working with confidence
module.exports.getUserAllocationsAndAccountTxs = async (clientId, floatId, startTime, endTime) => {
    logger('Looking for float-user discrepancies on floatId: ', floatId);
    const floatTxTable = config.get('tables.floatTxTable');
    const accountTxTable = config.get('tables.transactionTable');

    const start = startTime ? startTime.format() : moment(0).format();
    const end = endTime ? endTime.format() : moment().format();

    const sumFloatQuery = `select currency, unit, sum(amount) from ${floatTxTable} where ` +
        `allocated_to_type = $1 and t_state = $2 and creation_time between $3 and $4 and client_id = $5 and float_id = $6 ` +
        `group by currency, unit`;
    const sumFloatValues = ['END_USER_ACCOUNT', 'SETTLED', start, end, clientId, floatId];

    logger('Sum float query detailed: ', sumFloatQuery);
    const floatQueryResult = await rdsConnection.selectQuery(sumFloatQuery, sumFloatValues);
    logger('Float query result: ', floatQueryResult);
    const floatAccountTotal = opsUtil.assembleCurrencyTotals(floatQueryResult);


    const sumAccountQuery = `select currency, unit, sum(amount) from ${accountTxTable} where ` +
        `settlement_status = $1 and settlement_time between $2 and $3 and client_id = $4 and float_id = $5 ` +
        `group by currency, unit`;
    const sumAccountValues = ['SETTLED', start, end, clientId, floatId];

    const accountQueryResult = await rdsConnection.selectQuery(sumAccountQuery, sumAccountValues);
    logger('Account query result: ', accountQueryResult);
    const accountTxTotal = opsUtil.assembleCurrencyTotals(accountQueryResult);
    logger('Summed and mapped to currencies: ', accountTxTotal);

    return { floatAccountTotal, accountTxTotal };
};

const aggregateAmountsAllocatedToType = (resultRows) => {
    const floatResultMap = new Map();

    resultRows.forEach((row) => {
        const rowCurrency = row['currency'];

        const existingDict = floatResultMap.get(row['float_id']);
        const floatAllocDict = existingDict || {};
        
        // first, get the row of the float's dict that corresponds to this row's allocated-to-entity
        const allocatedId = row['allocated_to_id'];
        const existingAllocationResult = floatAllocDict[allocatedId];

        // then, either create that row, with this currency as its first key, and then either extract the relevant currency
        // tuple, or else create that tuple
        
        // (1) if no existing result, create the dictionary, with one key in it 
        const allocatedResult = existingAllocationResult || { [rowCurrency]: { 'amount': 0, 'unit': defaultUnit } };
        // (2) if the dictionary does not have an entry for this row's currency, create it
        const thisCurrencySum = allocatedResult[rowCurrency] || { 'amount': 0, 'unit': defaultUnit };

        // then, do the sum and add it
        const thisAmountInDefaultUnit = opsUtil.convertToUnit(parseInt(row['sum'], 10), row['unit'], defaultUnit);
        thisCurrencySum.amount += thisAmountInDefaultUnit;

        logger(`Getting a bit messy, but just added ${thisAmountInDefaultUnit} to ${thisCurrencySum}`);

        // then rewind, setting the dict, and then setting the overall, and then updating the map
        allocatedResult[rowCurrency] = thisCurrencySum;
        floatAllocDict[allocatedId] = allocatedResult;

        floatResultMap.set(row['float_id'], floatAllocDict);
    });

    logger('Returning allocation results: ', floatResultMap);
    return floatResultMap;
};

/**
 * NOTE: amountPosNeg controls whether outflows and inflows only or both, i.e., whether sum is on amount > 0, < 0 or both
 * Set it to 0 for both (i.e., for sums), to -1 for negative amounts only (i.e., outflows), and to +1 for positive amounts
 */
module.exports.getFloatBonusBalanceAndFlows = async (floatIds, startTime, endTime, amountPosNeg = 0) => {
    logger('Fetching bonus for float: ', floatIds);

    const floatTxTable = config.get('tables.floatTxTable');

    const nonFloatIdArgs = 4;
    const floatIndices = extractArrayIndices(floatIds, nonFloatIdArgs + 1);

    const start = startTime ? startTime.format() : moment(0).format();
    const end = endTime ? endTime.format() : moment().format();

    let whereClauseEnd = `and creation_time between $3 and $4`;
    if (amountPosNeg < 0) {
        whereClauseEnd = `${whereClauseEnd} and amount < 0`;
    } else if (amountPosNeg > 0) {
        whereClauseEnd = `${whereClauseEnd} and amount > 0`;
    }
    
    const sumQuery = `select float_id, currency, unit, allocated_to_id, sum(amount) from ${floatTxTable} where ` +
        `allocated_to_type = $1 and t_state = $2 ${whereClauseEnd} ` +
        `and float_id in (${floatIndices}) group by float_id, currency, unit, allocated_to_id`;
    
    const queryValues = ['BONUS_POOL', 'SETTLED', start, end, ...floatIds];
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);

    logger('Result of bonus pool sum query: ', queryResult);
    return aggregateAmountsAllocatedToType(queryResult);
};

module.exports.getLastFloatAccrualTime = async (floatId, clientId) => {
    logger('Getting last float accrual, for float: ', floatId);

    const floatLogTable = config.get('tables.floatLogTable');
    const floatTxTable = config.get('tables.floatTxTable');

    const selectionQuery = `select reference_time from ${floatLogTable} where float_id = $1 and client_id = $2 and log_type = $3 ` + 
        `order by creation_time desc limit 1`;
    const resultOfQuery = await rdsConnection.selectQuery(selectionQuery, [floatId, clientId, 'WHOLE_FLOAT_ACCRUAL']);
    logger('Retrieved result of float log selection: ', resultOfQuery);

    if (Array.isArray(resultOfQuery) && resultOfQuery.length > 0) {
        return moment(resultOfQuery[0]['reference_time']);
    }

    // if there has been no accrual, so above is not triggered, instead get the first time money was added        
    const findFirstTxQuery = `select creation_time from ${floatTxTable} where float_id = $1 and client_id = $2 and allocated_to_type = $3 ` +
        `order by creation_time asc limit 1`;

    logger('Searching for first accrual tx with query: ', findFirstTxQuery);
    const resultOfSearch = await rdsConnection.selectQuery(findFirstTxQuery, [floatId, clientId, 'FLOAT_ITSELF']);
    logger('Result of getting first transaction time: ', resultOfSearch);
    if (Array.isArray(resultOfSearch) && resultOfSearch.length > 0) {
        return moment(resultOfSearch[0]['creation_time']);
    }

    return null;
};

module.exports.getFloatAlerts = async (clientId, floatId, restrictToLogTypes) => {
    const floatLogTable = config.get('tables.floatLogTable');
    const logTypes = restrictToLogTypes || config.get('defaults.floatAlerts.logTypes');

    const selectQuery = `select * from ${floatLogTable} where client_id = $1 and float_id = $2 ` + 
        `and log_type in (${extractArrayIndices(logTypes, 3)}) order by updated_time desc`;
    const values = [clientId, floatId, ...logTypes];

    logger('Running float log alert query: ', selectQuery);
    logger('With values: ', values);
    const resultOfSearch = await rdsConnection.selectQuery(selectQuery, values);
    return camelcaseKeys(resultOfSearch);
};

/**
 * 
 * @param {object} logObject The log to insert, has the following _required_ properties:
 * @property {string} clientId The client ID of the float in question
 * @property {string} floatId The float Id
 * @property {string} logType The type of the log
 * @property {object} logContext The log context, can be any object, if nothing, pass empty
 */
module.exports.insertFloatLog = async (logObject) => {
    const floatLogTable = config.get('tables.floatLogTable');
    
    const logId = uuid();
    const logRow = { logId, ...logObject };

    const insertQuery = `insert into ${floatLogTable} (log_id, client_id, float_id, log_type, log_context) values %L returning log_id`;
    const columnTemplate = '${logId}, ${clientId}, ${floatId}, ${logType}, ${logContext}';
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [logRow]);
    logger('Result of inserting log: ', resultOfInsert);

    return resultOfInsert['rows'][0]['log_id'];
};

module.exports.getFloatLogsWithinPeriod = async (configForQuery) => {
    const {
        clientId,
        floatId,
        startTime,
        endTime,
        logTypes
    } = configForQuery;
    const floatLogTable = config.get('tables.floatLogTable');
    const startIndexForLogTypesInSQLParams = 5;
    const selectQuery = `select * from ${floatLogTable} where client_id = $1 and float_id = $2 ` +
        `where creation_time >= $3 and creation_time <= $4 log_type in (${extractArrayIndices(logTypes, startIndexForLogTypesInSQLParams)})`;
    const values = [clientId, floatId, startTime, endTime, ...logTypes];

    logger('Running get float logs within period alert query: ', selectQuery);
    logger('With values: ', values);
    const resultOfSearch = await rdsConnection.selectQuery(selectQuery, values);
    return resultOfSearch.length > 0 ? camelcaseKeys(resultOfSearch) : null;
};

module.exports.updateFloatLog = async ({ logId, contextToUpdate }) => {
    const floatLogTable = config.get('tables.floatLogTable');

    const updateQuery = `update ${floatLogTable} set log_context = log_context || $1 where log_id = $2`;
    logger('Updating log with query: ', updateQuery, ' and log context: ', contextToUpdate);
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [contextToUpdate, logId]);
    logger('Result of updating log: ', resultOfUpdate);

    return resultOfUpdate;
};
