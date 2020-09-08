'use strict';

const logger = require('debug')('jupiter:activity:dynamo');

const crypto = require('crypto');
const config = require('config');
const moment = require('moment');

const util = require('ops-util-common');

const dynamoCommon = require('dynamo-common');

const Redis = require('ioredis');

const clientFloatVariablePrefix = config.get('cache.keyPrefixes.clientFloat');

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

const initiateCacheConnection = async (keyPrefix = ) => {
    logger('Initiating connection to cache');
    try {
        const connectionToCache = new Redis({ 
            port: config.get('cache.port'), 
            host: config.get('cache.host'),
        });
        logger('Successfully initiated connection to cache');
        return connectionToCache;
    } catch (error) {
        logger(`Error while initiating connection to cache. Error: ${JSON.stringify(error.message)}`);
        return null;
    }
};

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////// FETCHING CLIENT-FLOAT VARS /////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////////////

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

    const responseFromCache = await cache.get(`${clientFloatVariablePrefix}::${cacheKeyWithoutPrefixForFloatVars}`);
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

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////// HANDLING BANK VERIFICATION /////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////////////

// These functions handle storing the fact that a set of bank account details have been verified (or not)
const hashBankDetails = (bankDetails) => crypto.createHash(HASH_ALGORITHM).update(JSON.stringify({
    bankName: bankDetails.bankName,
    accountNumber: bankDetails.accountNumber,
    accountType: bankDetails.accountType
})).digest('hex');

const assembleUpdateParams = (itemKey, updateExpression, substitutionDict) => ({
    tableName: config.get('tables.bankVerification'),
    itemKey,
    updateExpression,
    substitutionDict,
    returnOnlyUpdated: true
});

module.exports.fetchBankVerificationResult = async (systemWideUserId, bankDetails) => {
    const accountHash = hashBankDetails(bankDetails);
    logger('Fetching with Hash: ', accountHash, ' and user ID: ', systemWideUserId);

    const lookupTable = config.get('tables.bankVerification');
    const lookupResult = await dynamoCommon.fetchSingleRow(lookupTable, { systemWideUserId, accountHash });
    logger('Retrieved bank verification record: ', lookupResult);

    if (util.isObjectEmpty(lookupResult)) {
        return null;
    }

    const lastAccessMoment = moment(lookupResult.lastAccessTime);
    const thresholdMoment = moment().subtract(config.get('bank.validity.length'), config.get('bank.validity.unit'));
    logger('Comparing last access: ', lastAccessMoment, ' to threshold: ', thresholdMoment);

    if (lastAccessMoment.isBefore(thresholdMoment)) {
        logger('Verification is too old, remove it and return no record');
        // note : we do not use TTLs because we may adjust this time period after rows written
        const itemKey = { systemWideUserId, accountHash };
        await dynamoCommon.deleteRow({ tableName: lookupTable, itemKey });
        return null;
    }

    return {
        verificationStatus: lookupResult.verificationStatus,
        verificationLog: lookupResult.verificationLog,
        creationMoment: moment(lookupResult.creationTime),
        lastAccessMoment
    };
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
};

module.exports.setBankVerificationResult = async ({ systemWideUserId, bankDetails, verificationStatus, verificationLog }) => {
    const accountHash = hashBankDetails(bankDetails);
    const lookupTable = config.get('tables.bankVerification');

    const itemKey = { systemWideUserId, accountHash };
    logger('Setting verification result, checking first for prior, with hash and userID: ', itemKey);
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
        verificationStatus: verificationStatus
    };

    if (verificationLog) {
        itemToInsert.verificationLog = verificationLog;
    }

    logger('Persisting in DynamoDB: ', itemToInsert);
    const resultOfInsert = await dynamoCommon.insertNewRow(lookupTable, ['systemWideUserId', 'accountHash'], itemToInsert);
    logger('Result of insertion: ', resultOfInsert);

    return { ...resultOfInsert, persistedTime };
};

module.exports.updateLastVerificationUseTime = async (systemWideUserId, bankDetails, accessTime) => {
    const itemKey = { systemWideUserId, accountHash: hashBankDetails(bankDetails) }; 
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
