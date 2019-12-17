'use strict';

const config = require('config');
const logger = require('debug')('pluto:activity:dynamo');

const dynamoCommon = require('dynamo-common');

const relevantFloatColumns = ['accrualRateAnnualBps', 
    'bonusPoolShareOfAccrual', 
    'clientShareOfAccrual', 
    'prudentialFactor', 
    'defaultTimezone', 
    'currency', 
    'comparatorRates', 
    'bankDetails'
];

/**
 * This function fetches float variables for balance calculation.
 * @param {string} clientId The persisted client id.
 * @param {string} floatId The persisted fload id.
 */
module.exports.fetchFloatVarsForBalanceCalc = async (clientId, floatId) => {
    if (!clientId || !floatId) {
        throw new Error('Error! One of client ID or float ID missing');
    }
    
    logger(`Fetching needed variables for clientId-floatId: ${clientId}-${floatId} from table: ${config.get('tables.clientFloatVars')}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), { clientId, floatId }, relevantFloatColumns);
    
    logger('Result from DynamoDB: ', rowFromDynamo);
    
    if (!rowFromDynamo) {
        throw new Error(`Error! No config variables found for client-float pair: ${clientId}-${floatId}`);
    } 
    
    return rowFromDynamo;
};

module.exports.warmupCall = async () => {
    const emptyRow = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' });
    logger('Warmup result: ', emptyRow);
    return emptyRow;
};
