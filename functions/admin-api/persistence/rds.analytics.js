'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');

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
        whereClause = `((${txTimeClause}) or (${accountTable}.creation_time between $3 and $4)`;
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

module.exports.getFloatBalanceAndFlows = async (floatIds) => {
    logger('Fetching balance for floats: ', floatIds);

    const floatTxTable = config.get('tables.floatTxTable');
    const floatIndices = extractArrayIndices(floatIds);
    
    const sumQuery = `select float_id, currency, unit, sum(amount) from ${floatTxTable} where float_id in (${floatIndices}) ` +
        `and allocated_to_type = $${floatIds.length + 1} group by float_id, currency, unit`;
    const queryValues = [...floatIds, 'FLOAT_ITSELF'];
    logger('Executing query: ', sumQuery, ', with values: ', queryValues);
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);
    
    return aggregateFloatTotals(queryResult);
};

module.exports.getFloatBonusBalanceAndFlows = async (floatIds) => {
    logger('Fetching bonus for float: ', floatIds);

    const floatTxTable = config.get('tables.floatTxTable');
    const floatIndices = extractArrayIndices(floatIds);

    const sumQuery = `select float_id, currency, unit, allocated_to_id, sum(amount) from ${floatTxTable} where float_id in (${floatIndices}) ` +
        `and allocated_to_type = $${floatIds.length + 1} group by float_id, currency, unit, allocated_to_id`;
    const queryValues = [...floatIds, 'BONUS_POOL'];
    const queryResult = await rdsConnection.selectQuery(sumQuery, queryValues);

    logger('Result of bonus pool sum query: ', queryResult);
    return aggregateAllocatedAmounts(queryResult);
};
