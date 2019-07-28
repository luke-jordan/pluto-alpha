'use strict';

const config = require('config');
const logger = require('debug')('pluto:activity:dynamo');

const dynamoCommon = require('dynamo-common');

module.exports.fetchFloatVarsForBalanceCalc = async (clientId, floatId) => {
    if (!clientId || !floatId) {
        throw new Error('Error! One of client ID or float ID missing');
    }
    
    logger(`Fetching needed variables for clientId-floatId: ${clientId}-${floatId} from table: ${config.get('tables.clientFloatVars')}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), {
        clientId,
        floatId
    }, ['accrualRateAnnualBps', 'bonusPoolShareOfAccrual', 'clientShareOfAccrual', 'prudentialFactor', 'defaultTimezone', 'currency']);
    
    logger('Result from DynamoDB: ', rowFromDynamo);
    
    if (!rowFromDynamo) {
        throw new Error(`Error! No config variables found for client-float pair: ${clientId}-${floatId}`);
    } 
    
    return rowFromDynamo;
};
