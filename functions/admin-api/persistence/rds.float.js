'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');
const moment = require('moment');

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

const aggregateAllocatedAmounts = (resultRows) => {
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

module.exports.getFloatBalanceAndFlows = async (floatIds, startTime, endTime) => {
    logger('Fetching balance for floats: ', floatIds);

    const floatTxTable = config.get('tables.floatTxTable');
    const floatIndices = extractArrayIndices(floatIds);

    const start = startTime ? startTime.format() : moment(0).format();
    const end = endTime ? endTime.format() : moment().format();

    const floatIdxNo = floatIds.length;
    const typeOffset = 1;
    const startTimeOffset = 2;
    const endTimeOffset = 3;
    
    const sumQuery = `select float_id, currency, unit, sum(amount) from ${floatTxTable} where float_id in (${floatIndices}) ` +
        `and allocated_to_type = $${floatIdxNo + typeOffset} and creation_time between $${floatIdxNo + startTimeOffset} and ` + 
        `$${floatIdxNo + endTimeOffset} group by float_id, currency, unit`;
    
    const queryValues = [...floatIds, 'FLOAT_ITSELF', start, end];
    logger('Executing query: ', sumQuery, ', with values: ', queryValues);
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);
    
    return aggregateFloatTotals(queryResult);
};

/**
 * NOTE: amountPosNeg controls whether outflows and inflows only or both, i.e., whether sum is on amount > 0, < 0 or both
 * Set it to 0 for both (i.e., for sums), to -1 for negative amounts only (i.e., outflows), and to +1 for positive amounts
 */
module.exports.getFloatBonusBalanceAndFlows = async (floatIds, startTime, endTime, amountPosNeg = 0) => {
    logger('Fetching bonus for float: ', floatIds);

    const floatTxTable = config.get('tables.floatTxTable');
    const floatIndices = extractArrayIndices(floatIds);

    const start = startTime ? startTime.format() : moment(0).format();
    const end = endTime ? endTime.format() : moment().format();

    const startTimeIdx = 2;
    const endTimeIdx = 3;

    let whereClauseEnd = `and creation_time between $${floatIds.length + startTimeIdx} and $${floatIds.length + endTimeIdx}`;
    if (amountPosNeg < 0) {
        whereClauseEnd = `${whereClauseEnd} and amount < 0`;
    } else if (amountPosNeg > 0) {
        whereClauseEnd = `${whereClauseEnd} and amount > 0`;
    }
    
    const sumQuery = `select float_id, currency, unit, allocated_to_id, sum(amount) from ${floatTxTable} where float_id in (${floatIndices}) ` +
        `and allocated_to_type = $${floatIds.length + 1} ${whereClauseEnd} group by float_id, currency, unit, allocated_to_id`;
    
    const queryValues = [...floatIds, 'BONUS_POOL', start, end];
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);

    logger('Result of bonus pool sum query: ', queryResult);
    return aggregateAllocatedAmounts(queryResult);
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

module.exports.getFloatAlerts = async (clientId, floatId) => {
    const floatLogTable = config.get('tables.floatLogTable');
    const logTypes = config.get('defaults.floatAlerts.logTypes');

    const selectQuery = `select * from ${floatLogTable} where client_id = $1 and float_id = $2 ` + 
        `and log_type in (${extractArrayIndices(logTypes)}) order by updated_time desc`;
    const values = [clientId, floatId, ...logTypes];

    logger('Running query: ', selectQuery);
    const resultOfSearch = await rdsConnection.selectQuery(selectQuery, values);
    return camelcaseKeys(resultOfSearch);
};

module.exports.insertFloatLog = async (logObject = { clientId, floatId, logType, logContext }) => {
    const floatLogTable = config.get('tables.floatLogTable');
    
    const insertQuery = `insert into ${floatLogTable} (client_id, float_id, log_type, log_context) values %L returning log_id`;
    const columnTemplate = '${clientId}, ${floatId}, ${logType}, ${logContext}';
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [logObject]);
    logger('Result of inserting log: ', this.insertFloatLog);

    return resultOfInsert['rows'][0]['log_id'];
};

module.exports.updateFloatLog = async ({ logId, contextToUpdate }) => {

}