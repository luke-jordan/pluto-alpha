'use strict';

const logger = require('debug')('jupiter:activity:calculations');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const txTable = config.get('tables.accountTransactions');
const userAccountTable = config.get('tables.accountLedger');
const heatStateTable = config.get('tables.heatStateLedger');
const heatLevelTable = config.get('tables.heatLevelThreshold');

const DEFAULT_UNIT = 'HUNDREDTH_CENT';

const convertMillisToFormat = (epochMillis) => moment(parseInt(epochMillis, 10)).format();

const accountSumQuery = async (params, systemWideUserId) => {
    // const transTypesToInclude = [`'USER_SAVING_EVENT'`, `'ACCRUAL'`, `'CAPITALIZATION'`, `'WITHDRAWAL'`].join(',')
    const query = `select sum(amount), unit from ${userAccountTable} inner join ${txTable} ` +
        `on ${userAccountTable}.account_id = ${txTable}.account_id ` +
        `where owner_user_id = $1 and currency = $2 and settlement_status = $3 group by unit`;
    const fetchRows = await rdsConnection.selectQuery(query, [systemWideUserId, params.currency, 'SETTLED']);
    logger('Result from select: ', fetchRows);
    return { ...params, amount: opsUtil.sumOverUnits(fetchRows, params.unit) };
};

const interestHistoryQuery = async (params, systemWideUserId) => {
    const transTypesToInclude = ['ACCRUAL', 'CAPITALIZATION'];
    const cutOffMoment = moment(parseInt(params.startTimeMillis, 10));
    
    /* eslint-disable no-magic-numbers */
    const query = `select sum(amount), unit from ${userAccountTable} inner join ${txTable} ` +
        `on ${userAccountTable}.account_id = ${txTable}.account_id ` + 
        `where owner_user_id = $1 and currency = $2 and settlement_status = $3 and ${txTable}.creation_time > $4 ` +
        `and transaction_type in (${opsUtil.extractArrayIndices(transTypesToInclude, 5)}) group by unit`;
    /* eslint-enable no-magic-numbers */
    
    const values = [systemWideUserId, params.currency, 'SETTLED', cutOffMoment.format(), ...transTypesToInclude];
    const fetchRows = await rdsConnection.selectQuery(query, values);
    logger('Interest query, result from RDS: ', fetchRows);
    return { ...params, amount: opsUtil.sumOverUnits(fetchRows, params.unit) };
};

const capitalizationQuery = async (params, systemWideUserId) => {
    const result = { currency: params.currency, unit: DEFAULT_UNIT};
    if (params.startTimeMillis && params.endTimeMillis) {
        const sumQuery = `select sum(amount), unit from ${userAccountTable} inner join ${txTable} ` + 
            `on ${userAccountTable}.account_id = ${txTable}.account_id where owner_user_id = $1 ` +
            `and transaction_type = $2 and settlement_status = $3 and currency = $4 and ` +
            `creation_time between $5 and $6 group by unit`;
        const values = [systemWideUserId, 'CAPITALIZATION', 'SETTLED', params.currency, 
            moment(params.startTimeMillis).format(), moment(params.endTimeMillis).format()];
        const fetchRows = await rdsConnection.selectQuery(sumQuery, values);
        logger('Capitalization query, result from RDS: ', fetchRows);
        result.amount = opsUtil.sumOverUnits(fetchRows, DEFAULT_UNIT);
    } else {
        const selectQuery = `select amount, unit from ${userAccountTable} inner join ${txTable} ` +
            `on ${userAccountTable}.account_id = ${txTable}.account_id where owner_user_id = $1 ` +
            `and transaction_type = $2 and settlement_status = $3 order by ${txTable}.creation_time desc limit 1`;
        const selectValues = [systemWideUserId, 'CAPITALIZATION', 'SETTLED']; 
        const fetchRow = await rdsConnection.selectQuery(selectQuery, selectValues);
        logger('Finding last capitalization, result from RDS: ', fetchRow);
        result.amount = fetchRow.length === 0 ? 0 : opsUtil.convertToUnit(fetchRow[0]['amount'], fetchRow[0]['unit'], DEFAULT_UNIT);
    }
    logger('Capitalization query result: ', result);
    return result;
};

const getLastTransactionOfType = async (params, systemWideUserId) => {
    const result = { currency: params.currency, unit: DEFAULT_UNIT};
    const selectQuery = `select amount, unit from ${userAccountTable} inner join ${txTable} ` +
        `on ${userAccountTable}.account_id = ${txTable}.account_id where owner_user_id = $1 ` +
        `and transaction_type = $2 and settlement_status = $3 order by ${txTable}.creation_time desc limit 1`;
    const selectValues = [systemWideUserId, params.txType, 'SETTLED']; 
    const fetchRow = await rdsConnection.selectQuery(selectQuery, selectValues);
    logger('Finding last transaction, result from RDS: ', fetchRow);
    result.amount = fetchRow.length === 0 ? 0 : opsUtil.convertToUnit(fetchRow[0]['amount'], fetchRow[0]['unit'], DEFAULT_UNIT);
    logger('last transaction query result: ', result);
    return result;    
};

const sumOverSettledTransactionTypes = async (params, systemWideUserId, transTypesToInclude) => {
    const queryValues = [systemWideUserId, params.currency, 'SETTLED']; 
    const queryTimeParts = [];
    let queryParamCount = queryValues.length + 1;

    if (params.startTimeMillis) {
        queryTimeParts.push(`creation_time > $${queryParamCount}`);
        queryValues.push(convertMillisToFormat(params.startTimeMillis));
        queryParamCount += 1;
    }
    if (params.endTimeMillis) {
        queryTimeParts.push(`creation_time < ${queryParamCount}`);
        queryValues.push(convertMillisToFormat(params.endTimeMillis));
        queryParamCount += 1;
    }

    const queryTimeSection = queryTimeParts.length > 0 ? `and ${queryTimeParts.join(' and ')}` : '';
    const queryTypeIndices = opsUtil.extractArrayIndices(transTypesToInclude, queryParamCount);
    
    const query = `select sum(amount), unit from ${userAccountTable} inner join ${txTable} ` +
        `on ${userAccountTable}.account_id = ${txTable}.account_id ` + 
        `where owner_user_id = $1 and currency = $2 and settlement_status = $3 ${queryTimeSection} ` +
        `and transaction_type in (${queryTypeIndices}) group by unit`;
    
    logger('For summing over settled tx query, assembled: ', query);
    logger('And sending in values: ', [...queryValues, ...transTypesToInclude]);
    const fetchRows = await rdsConnection.selectQuery(query, [...queryValues, ...transTypesToInclude]);
    logger('Fetched resuls for earnings query: ', fetchRows);

    return { ...params, amount: opsUtil.sumOverUnits(fetchRows, params.unit) };
};

const earningsQuery = async (params, systemWideUserId) => {
    const transTypesToInclude = ['ACCRUAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'BOOST_REVOCATION'];
    logger('Calling generic sum over settled, from earnings query, including: ', transTypesToInclude);
    return sumOverSettledTransactionTypes(params, systemWideUserId, transTypesToInclude);
};

const netSavingQuery = async (params, systemWideUserId) => {
    const transTypesToInclude = ['USER_SAVING_EVENT', 'WITHDRAWAL'];
    logger('Conducting a new savings query, tx types: ', transTypesToInclude);
    return sumOverSettledTransactionTypes(params, systemWideUserId, transTypesToInclude);
};

const savingHeatQuery = async (queryType, systemWideUserId) => {
    if (queryType === 'saving_heat_level') {
        const levelQuery = `select level_name from ${heatStateTable} inner join ${heatLevelTable} on ` + 
            `${heatStateTable}.current_level_id = ${heatLevelTable}.level_id where system_wide_user_id = $1`;
        const result = await rdsConnection.selectQuery(levelQuery, [systemWideUserId]);
        const levelName = result.length > 0 ? result[0]['level_name'] : config.get('defaults.heatLevel.none');
        return { currentLevelName: levelName };
    }

    const pointQuery = `select current_period_points from ${heatStateTable} where system_wide_user_id = $1`;
    const resultOfQuery = await rdsConnection.selectQuery(pointQuery, [systemWideUserId]);

    return { currentPeriodPoints: resultOfQuery.length > 0 ? resultOfQuery[0]['current_period_points'] : 0};
};

/* eslint-disable no-magic-numbers */
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
        case 'capitalization': {
            logger('Returning the last capitalization event (or sum over them in a period)');
            const currency = operationParams[1];
            const startTimeMillis = operationParams.length > 2 ? Number(operationParams[2]) : null;
            const endTimeMillis = operationParams.length > 3 ? Number(operationParams[3]) : null;
            return capitalizationQuery({ currency, startTimeMillis, endTimeMillis }, systemWideUserId);
        }
        case 'last_saved_amount': {
            logger('Returning user last saved amount');
            const currency = operationParams[1];
            return getLastTransactionOfType({ currency, txType: 'USER_SAVING_EVENT' }, systemWideUserId);
        }
        case 'total_earnings': {
            const params = { unit: operationParams[1], currency: operationParams[2] };
            params.startTimeMillis = operationParams.length > 3 ? operationParams[3] : null;
            params.endTimeMillis = operationParams.length > 4 ? operationParams[4] : null;
            return earningsQuery(params, systemWideUserId);
        }
        case 'net_saving': {
            const params = { unit: operationParams[1], currency: operationParams[2] };
            params.startTimeMillis = operationParams.length > 3 ? operationParams[3] : null;
            params.endTimeMillis = operationParams.length > 4 ? operationParams[4] : null;
            return netSavingQuery(params, systemWideUserId);
        }
        case 'saving_heat_points':
        case 'saving_heat_level': {
            return savingHeatQuery(operation, systemWideUserId);
        }
        default:
            return null;
    }
};
/* eslint-enable no-magic-numbers */

/**
 * Retrieves figures for the user according to a simple set of instructions, of the form:
 * <variable_of_interest>::<unit>::<currency>(optionally::anything_else_relevant)
 * Currently supported:
 * balance::<unit>::<currency>> : gets the user's balance according to the specified currency
 * interest::<unit>::<currency>>::<sinceEpochMillis>> : adds up the interest capitalized and accrued since the given instant (in millis)
 * capitalization::<currency>::<startEpochMillis>>::<endEpochMillis> : adds up capitalization between times; if no times provided, returns last capitalization
 * total_earnings::<unit>::<currency>>::<startMillis>::<endMillis> : adds up interest + boosts in the period, or all time if no period provided
 * net_saving::<unit>::<currency>::<startMillis>::<endMillis> : adds up savings - withdrawals in the period, or all time
 *
 * also for convenience can fetch saving heat figures
 * saving_heat_points : gets current period saving points
 * saving_heat_level : gets current level
 */
module.exports.getUserAccountFigure = async ({ systemWideUserId, operation }) => {
    logger('User ID: ', systemWideUserId);
    const operationParams = operation.split('::');
    logger('Params for operation: ', operationParams);
    const resultOfOperation = await executeAggregateOperation(operationParams, systemWideUserId);
    logger('Result of operation: ', resultOfOperation);
    
    if (!resultOfOperation) {
        return null;
    }

    const isHeatFigure = operation.startsWith('saving_heat');
    if (isHeatFigure) {
        return resultOfOperation;
    }

    return { amount: resultOfOperation.amount, unit: resultOfOperation.unit, currency: resultOfOperation.currency };
};
