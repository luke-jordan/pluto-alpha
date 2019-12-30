'use strict';

const config = require('config');
const logger = require('debug')('jupiter:float:dynamo');

const dynamoCommon = require('dynamo-common');

// for fetching both of them, as and when we require it
module.exports.fetchConfigVarsForFloat = async (clientId = 'zar_client_co', floatId = 'zar_mmkt_float') => {
    const requireedColumns = ['bonusPoolShareOfAccrual', 'bonusPoolSystemWideId', 'clientShareOfAccrual', 'clientShareSystemWideId'];
    const dynamoRow = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), { clientId, floatId }, requireedColumns);
    logger('Fetched config var row from dynamo: ', dynamoRow);
    return {
        bonusPoolShare: dynamoRow.bonusPoolShareOfAccrual,
        bonusPoolTracker: dynamoRow.bonusPoolSystemWideId,
        clientCoShare: dynamoRow.clientShareOfAccrual,
        clientCoShareTracker: dynamoRow.clientShareSystemWideId
    };
};

