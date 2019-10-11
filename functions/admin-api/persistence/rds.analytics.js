'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const defaultUnit = 'HUNDREDTH_CENT';

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

/** 
 * Does what it says on the tin -- counts the users with accounts open, where there has been
 * a transaction within the last X days, up until the current
 */
module.exports.countUserIdsWithAccounts = async (sinceMoment, untilMoment, includeNoSave = false) => {
    logger(`Fetching users with accounts open and transactions between ${sinceMoment} and ${untilMoment}`);
    const accountTable = config.get('tables.accountTable');
    const transactionTable = config.get('tables.transactionTable');

    let joinType = '';
    let whereClause = '';
    
    const txTimeClause = `${transactionTable}.creation_time between $3 and $4`; // see below for 1 and 2
    const values = ['USER_SAVING_EVENT', 'SETTLED', sinceMoment.format(), untilMoment.format()];

    if (includeNoSave) {
        joinType = 'left join';
        whereClause = `((${txTimeClause}) or (${accountTable}.creation_time between $3 and $4))`;
    } else {
        joinType = 'inner join';
        whereClause = txTimeClause;
    }

    const countQuery = `select count(distinct(owner_user_id)) from ${accountTable} ${joinType} ${transactionTable} on ` + 
            `${accountTable}.account_id = ${transactionTable}.account_id where transaction_type = $1 and settlement_status = $2 and ` +
            `${whereClause}`;

    logger('Assembled count query: ', countQuery);
    const resultOfCount = await rdsConnection.selectQuery(countQuery, values);
    logger('Result of count: ', resultOfCount);
    return resultOfCount[0]['count'];
};

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

module.exports.getLastFloatAccrualTime = async (floatId) => {
    logger('Getting last float accrual');

    const floatLogTable = config.get('tables.floatLogs');
    const floatTxTable = config.get('tables.floatTxTable');

    const selectionQuery = `select reference_time from ${floatLogTable} where float_id = $1 and log_type = $2 ` + 
        `order by creation_time desc limit 1`;
    const resultOfQuery = await rdsConnection.selectQuery(selectionQuery, [floatId, 'WHOLE_FLOAT_ACCRUAL']);
    logger('Retrieved result of float log selection: ', resultOfQuery);

    if (Array.isArray(resultOfQuery) && resultOfQuery.length > 0) {
        return moment(resultOfQuery[0]['creation_time']);
    }

    // if there has been no accrual, so above is not triggered, instead get the first time money was added        
    const findFirstTxQuery = `select creation_time from ${floatTxTable} where float_id = $1 and allocated_to_type = $2 ` +
        `order by creation_time asc limit 1`;

    const resultOfSearch = await rdsConnection.selectQuery(findFirstTxQuery, [floatId, 'FLOAT_ITSELF']);
    logger('Result of getting first transaction time: ', resultOfSearch);
    if (Array.isArray(resultOfSearch) && resultOfSearch.length > 0) {
        return moment(resultOfSearch[0]['creation_time']);
    }

    return null;
};
