'use strict';

const logger = require('debug')('jupiter:heat:main');
const moment = require('moment');
const opsUtil = require('ops-util-common');

const rds = require('./persistence/rds');
const dynamo = require('./persistence/dynamodb');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    retryStrategy: () => `dont retry`
});

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const calculateGrowthInTotalAmountSaved = async (accountId, activeMonths) => {
    const currency = await rds.findMostCommonCurrency(accountId);
    logger('Got most common currency:', currency);
    const [totalAmountSaved, amountSavedLastMonth] = await Promise.all([
        rds.sumAmountSaveLastMonth(accountId, currency),
        rds.sumAmountSavedLastMonth(accountId, currency)
    ]);

    const avgSavedAmountPerMonth = totalAmountSaved / activeMonths;
    const avgGrowth = Math.round(((amountSavedLastMonth - avgSavedAmountPerMonth) / avgSavedAmountPerMonth) * 100);

    return avgGrowth * 0.01;
};

const countActiveSavingFriendsForUser = async (systemWideUserId) => {
    const friendsFetchLambdaInvoke = invokeLambda(config.get('lambdas.obtainFriends'), { systemWideUserId });
    logger('Invoke friends fetch with arguments: ', friendsFetchLambdaInvoke);
    const friendsFetchResult = await lambda.invoke(friendsFetchLambdaInvoke).promise();
    logger('Result of friends fetch: ', friendsFetchResult);
    const friendCount = extractLambdaBody(friendsFetchResult).length;
    
    return friendCount;
};

const calculateAndCacheHeatScore = async (accountId) => {
    // validate user has prior saves
    const ownerInfo = await persistence.getOwnerInfoForAccount(accountId)
    const systemWideUserId = ownerInfo.ownerUserId;

    const [accOpenedDate, totalNumberOfSaves, numberOfSavesLastMonth, numberOfSavingFriendships] = await Promise.all([
        dynamo.getAccountOpenedForHeatCalc(systemWideUserId),
        rds.countSettledSaves(accountId),
        rds.countSettledSavesForPrevMonth(accountId),
        countActiveSavingFriendsForUser(systemWideUserId)
    ]);
  
    const activeMonths = moment(accOpenedDate).diff(moment().startOf('month'), 'month');
    const avgNumberOfSavesPerMonth = totalNumberOfSaves / activeMonths;

    const avgGrowthInSavedAmount = await calculateGrowthInTotalAmountSaved(accountId, activeMonths);

    const heatScore = (0.5 * avgNumberOfSavesPerMonth) + (0.5 * numberOfSavesLastMonth) + (10 * avgGrowthInSavedAmount) + (numberOfSavingFriendships / 4);

    const key = `${config.get('reedis.keyPrefixes.heatScore')}::${accountId}`;
    await redis.set(key, JSON.stringify({ heatScore }), 'EX', config.get('cache.ttls.savingHeat'));

    return { accountId, heatScore };
};

module.exports.calculateSavingsHeat = async (event) => {
    try {
        const { accountId, floatId, clientId } = opsUtil.extractParamsFromEvent(event);

        let accountIds = [];
        if (!accountId && !floatId && !clientId) {
            accountIds = persistence.fetchAccounts();
        }
    
        if (accountId) {
            accountIds = [accountId];
        };
    
        if (floatId || clientId) {
            if (floatId) {
                accountIds = persistence.findAccountsForFloat(floatId)
            }

            if (client) {
                accountIds = persistence.findAccountsForClient(clientId);
            }
        }

        const heatCalculations = accountIds.map((accountId) => calculateAndCacheHeatScore(accountId));
        const resultOfCalculations = await Promise.all(heatCalculations);
        logger('Result of heat calculations:', resultOfCalculations);

        return { result: 'SUCCESS', details: resultOfCalculations };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', message: err.message };
    }
  
};