'use strict';

const config = require('config');
const logger = require('debug')('pluto:activity:dynamo');

const dynamoCommon = require('dynamo-common');
const Redis = require('ioredis');
const CACHE_TTL_IN_SECONDS = 3600;

const relevantFloatColumns = ['accrualRateAnnualBps', 
    'bonusPoolShareOfAccrual', 
    'clientShareOfAccrual', 
    'prudentialFactor', 
    'defaultTimezone', 
    'currency', 
    'comparatorRates', 
    'bankDetails'
];

const initiateCacheConnection = async () => {
    logger('Initiating connection to cache');
    try {
        // TODO: change `retryStrategy` to default when redis-connection is set
        const connectionToCache = new Redis({ port: config.get('cache.port'), host: config.get('cache.host'), retryStrategy: () => `dont retry`});
        logger('Successfully initiated connection to cache');
        return connectionToCache;
    } catch (error) {
        logger(`Error while initiating connection to cache. Error: ${JSON.stringify(error.message)}`);
    }
};

const fetchFloatVarsForBalanceCalcFromDB = async (clientId, floatId) => {
    logger(`Fetching 'float vars for balance calc' from database`);
    logger(`Fetching needed variables for clientId-floatId: ${clientId}-${floatId} from table: ${config.get('tables.clientFloatVars')}`);
    const rowFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), { clientId, floatId }, relevantFloatColumns);

    logger('Result from DynamoDB: ', rowFromDynamo);

    if (!rowFromDynamo) {
        throw new Error(`Error! No config variables found for client-float pair: ${clientId}-${floatId}`);
    }

    return rowFromDynamo;
};

const fetchFloatVarsForBalanceCalcFromCache = async (cacheKeyForFloatVars) => {
    logger(`Fetching 'float vars for balance calc' from cache`);
    const cache = await initiateCacheConnection();
    if (!cache || cache.status === 'connecting') {
        return { cache: null, responseFromCache: null };
    }

    const responseFromCache = await cache.get(cacheKeyForFloatVars);
    return { cache, responseFromCache };
};

const fetchFloatVarsForBalanceCalcFromCacheOrDB = async (clientId, floatId) => {
    logger(`Fetching 'float vars for balance calc' from database or cache`);
    const cacheKeyForFloatVars = `${clientId}_${floatId}_float_vars_for_balance_calc`;
    try {
        // TODO: simplify logic when redis-connection is setup
        const { cache, responseFromCache } = await fetchFloatVarsForBalanceCalcFromCache(cacheKeyForFloatVars);
        if (!responseFromCache) {
            logger(`${cacheKeyForFloatVars} NOT found in cache`);
            const floatProjectionVars = await fetchFloatVarsForBalanceCalcFromDB(clientId, floatId);
            if (cache) {
                logger(`Successfully fetched 'float vars for balance calc' from database and stored in cache`);
                await cache.set(cacheKeyForFloatVars, JSON.stringify(cacheKeyForFloatVars), 'EX', CACHE_TTL_IN_SECONDS);
            }

            logger(`Successfully fetched 'float vars for balance calc' from database and NOT stored in cache`);
            return floatProjectionVars;
        }

        logger(`Successfully fetched 'interest rate' from cache`);
        return responseFromCache;
    } catch (error) {
        logger(`Error occurred while fetching 'float vars for balance calc' from database or cache.
        Error: ${JSON.stringify(error.message)}`);
        throw error;
    }
};

/**
 * This function fetches float variables for balance calculation.
 * @param {string} clientId The persisted client id.
 * @param {string} floatId The persisted fload id.
 */
module.exports.fetchFloatVarsForBalanceCalc = async (clientId, floatId) => {
    if (!clientId || !floatId) {
        throw new Error('Error! One of client ID or float ID missing');
    }

    return fetchFloatVarsForBalanceCalcFromCacheOrDB(clientId, floatId);
};

module.exports.warmupCall = async () => {
    const emptyRow = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' });
    logger('Warmup result: ', emptyRow);
    return emptyRow;
};
