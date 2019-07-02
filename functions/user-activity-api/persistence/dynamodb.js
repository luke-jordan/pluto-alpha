'use strict';

const config = require('config');
const logger = require('debug')('pluto:activity:dynamo');

const dynamoCommon = require('dynamo-common');

module.exports.fetchFloatVarsForBalanceCalc = async (clientId, floatId) => {
    logger(`Fetching needed variables for clientId-floatId: ${clientId}-${floatId}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), {
        clientId,
        floatId
    }, ['accrualRateAnnualBps', 'bonusPoolShareOfAccrual', 'clientShareOfAccrual', 'prudentialFactor', 'defaultTimezone']);
    logger('Result from Dynamo: ', rowFromDynamo);
    return rowFromDynamo;
};
