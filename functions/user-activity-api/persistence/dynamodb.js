'use strict';

const config = require('config');
const logger = require('debug')('pluto:activity:dynamo');
const util = require('ops-util-common');

const dynamoCommon = require('dynamo-common');

const Redis = require('ioredis');

const CACHE_TTL_IN_SECONDS = config.get('cache.ttls.clientFloat');
const HASH_ALGORITHM = config.get('bank.hash');

const relevantFloatColumns = [
    'accrualRateAnnualBps', 
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
        const connectionToCache = new Redis({ 
            port: config.get('cache.port'), 
            host: config.get('cache.host'), 
            retryStrategy: () => `dont retry`, 
            keyPrefix: `${config.get('cache.keyPrefixes.clientFloat')}::`
        });
        logger('Successfully initiated connection to cache');
        return connectionToCache;
    } catch (error) {
        logger(`Error while initiating connection to cache. Error: ${JSON.stringify(error.message)}`);
        return null;
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

const fetchFloatVarsForBalanceCalcFromCache = async (cacheKeyWithoutPrefixForFloatVars) => {
    logger(`Fetching 'float vars for balance calc' from cache`);
    const cache = await initiateCacheConnection();
    if (!cache || cache.status === 'connecting') {
        return { cache: null, responseFromCache: null };
    }

    const responseFromCache = await cache.get(cacheKeyWithoutPrefixForFloatVars);
    return { cache, responseFromCache };
};

const fetchFloatVarsForBalanceCalcFromCacheOrDB = async (clientId, floatId) => {
    logger(`Fetching 'float vars for balance calc' from database or cache`);
    const cacheKeyWithoutPrefixForFloatVars = `${clientId}_${floatId}`;
    const { cache, responseFromCache } = await fetchFloatVarsForBalanceCalcFromCache(cacheKeyWithoutPrefixForFloatVars);
    if (!responseFromCache) {
        logger(`${cacheKeyWithoutPrefixForFloatVars} NOT found in cache`);
        const floatProjectionVars = await fetchFloatVarsForBalanceCalcFromDB(clientId, floatId);
        if (cache) {
            logger(`Successfully fetched 'float vars for balance calc' from database and stored in cache`);
            await cache.set(cacheKeyWithoutPrefixForFloatVars, JSON.stringify(cacheKeyWithoutPrefixForFloatVars), 'EX', CACHE_TTL_IN_SECONDS);
        }

        logger(`Successfully fetched 'float vars for balance calc' from database and NOT stored in cache`);
        return floatProjectionVars;
    }

    logger(`Successfully fetched 'interest rate' from cache`);
    return responseFromCache;
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

/**
 * These functions handle storing the fact that a set of bank account details have been verified (or not)
 */

const hashBankDetails = (bankDetails) => crypto.creatHash(HASH_ALGORITHM).update(JSON.stringify(bankDetails).digest('hex')); 

const assembleUpdateParams = (itemKey, updateExpression, substitutionDict) => ({
    tableName: config.get('tables.bankVerification'),
    itemKey,
    updateExpression,
    substitutionDict,
    returnOnlyUpdated: true
});

module.exports.fetchBankVerificationResult = async (systemWideUserId, bankDetails) => {
    const accountHash = hashBankDetails(bankDetails);
    const lookupTable = config.get('tables.bankVerification');
    const lookupResult = await dynamoCommon.fetchSingleRow(lookupTable, { systemWideUserId, accountHash });
    logger('Retrieved bank verification record: ', lookupResult);

    if (util.isObjectEmpty(lookupResult)) {
        return { verificationStatus: 'NO_RECORD' };
    }

    const lastAccessMoment = moment(lookupResult.lastAccessTime);
    const thresholdMoment = moment().subtract(config.get('bank.threshold.amount'), config.get('bank.threshold.unit'));
    logger('Comparing last access: ', lastAccessMoment, ' to threshold: ', thresholdMoment);

    if (lastAccessMoment.isBefore(thresholdMoment)) {
        logger('Verification is too old, remove it and return no record');
        // note : we do not use TTLs because we may adjust this time period after rows written
        const itemKey = { systemWideUserId, accountHash };
        await dynamoCommon.deleteRow({ tableName: lookupTable, itemKey });
        return { verificationStatus: 'NO_RECORD' };
    }

    return lookupResult.verificationStatus;
};

const updateExistingResultFull = async (itemKey, verificationStatus, verificationLog) => {
    const accessTime = moment();
    // then the utter nightmare of the AWS SDK, even refractored/softened
    const updateClause = 'set verification_status = :vs, verification_log = :vl, last_access_time = :lt';
    const updateObject = { ':vs': verificationStatus, ':vl': verificationLog, ':lt': accessTime.valueOf() };
    const updateParams = assembleUpdateParams(itemKey, updateClause, updateObject);
    logger('Updating with params: ', updateParams);
    const updateResult = await dynamoCommon.updateRow(updateParams);
    logger('Result of update: ', updateResult);
    return updateResult;
}

module.exports.setBankVerificationResult = async ({ systemWideUserId, bankDetails, verificationStatus, verificationLog }) => {
    const accountHash = hashBankDetails(bankDetails);
    const lookupTable = config.get('tables.bankVerification');

    const itemKey = { systemWideUserId, accountHash };
    const existingItem = await dynamoCommon.fetchSingleRow(lookupTable, itemKey);
    if (!util.isObjectEmpty(existingItem)) {
        return updateExistingResultFull(itemKey, verificationStatus, verificationLog);
    }

    const persistedTime = moment();

    const itemToInsert = {
        systemWideUserId,
        accountHash,
        creationTime: persistedTime.valueOf(),
        lastAccessTime: persistedTime.valueOf(),
        verificationStatus: verificationStatus,
        verificationLog: verificationLog
    };

    logger('Persisting in DynamoDB: ', itemToInsert);
    const resultOfInsert = await dynamoCommon.insertNewRow(lookupTable, ['systemWideUserId', 'accountHash'], itemToInsert);
    logger('Result of insertion: ', resultOfInsert);

    return { ...resultOfInsert, persistedTime };
};

module.exports.updateLastVerificationUseTime = async (systemWideUserId, bankDetails, accessTime) => {

    const itemKey = { systemWideUserId, accountHash: hashBankDetails(bankDetails) },    
    const updateInstruction = assembleUpdateParams(itemKey, 'set last_access_time = :at', { ':at': accessTime.valueOf() });

    logger('Sending update parameters to Dynamo: ', updateInstruction);
    const resultOfUpdate = await dynamoCommon.updateRow(updateInstruction);
    logger('Result from DDB: ', resultOfUpdate);

    return resultOfUpdate;
};

module.exports.warmupCall = async () => {
    const emptyRow = await dynamoCommon.fetchSingleRow(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' });
    logger('Warmup result: ', emptyRow);
    return emptyRow;
};
