'use strict';

const logger = require('debug')('jupiter:heat:main');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');
const persistence = require('./persistence/rds');

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    keyPrefix: `${config.get('cache.keyPrefixes.savingsHeat')}::`
});

const CACHE_TTL_IN_SECONDS = config.get('cache.ttls.savingsHeat');

// These multipliers are used in calculating the savings heat score. AVG_GROWTH_PERCENT shifts the decimal point
// in the average growth percent (e.g 10 percent becomes 0.1). AVERAGE_GROWTH multiplies the adjusted average
// growth in the amount a user saves. SAVES_PER_MONTH multiplies the users average number of saves per month. SAVES_LAST_MONTH
// multiplies the users average number of saves over lifetime.
const MULTIPLIERS = {
    'AVG_GROWTH_PERCENT': 0.01, 
    'AVERAGE_GROWTH': 10,
    'SAVES_PER_MONTH': 0.5,
    'SAVES_LAST_MONTH': 0.5
};

const calculateGrowthInTotalAmountSaved = async (accountId, activeMonths) => {
    const currency = await persistence.findMostCommonCurrency(accountId);
    logger('Most common currency:', currency);
    const [totalAmountSaved, amountSavedLastMonth] = await Promise.all([
        persistence.sumTotalAmountSaved(accountId, currency),
        persistence.sumAmountSavedLastMonth(accountId, currency)
    ]);

    logger(`Active months: ${activeMonths}\nTotal saved: ${totalAmountSaved}\nLast month: ${amountSavedLastMonth}`);
    const avgSavedAmountPerMonth = totalAmountSaved / activeMonths;
    logger('Average saved per month:', avgSavedAmountPerMonth);
    const avgGrowth = Math.round(((amountSavedLastMonth - avgSavedAmountPerMonth) / avgSavedAmountPerMonth) * 100);
    logger('Average growth in savings:', avgGrowth);

    return avgGrowth * MULTIPLIERS.AVG_GROWTH_PERCENT;
};

const calculateAndCacheHeatScore = async (accountId) => {
    const ownerInfo = await persistence.getOwnerInfoForAccount(accountId);
    const systemWideUserId = ownerInfo.ownerUserId;

    const [totalNumberOfSaves, numberOfSavesLastMonth, numberOfSavingFriendships, accountOpenedDate] = await Promise.all([
        persistence.countSettledSaves(accountId),
        persistence.countSettledSavesForPrevMonth(accountId),
        persistence.countActiveSavingFriendsForUser(systemWideUserId),
        persistence.getAccountOpenedDateForHeatCalc(accountId)
    ]);

    logger(`Total savings: ${totalNumberOfSaves}\nNumber of savings last month: ${numberOfSavesLastMonth}`);
    logger(`Account opened date: ${accountOpenedDate}\nActive friendships: ${numberOfSavingFriendships}`);

    const activeMonths = Math.abs(moment(accountOpenedDate).diff(moment().startOf('month'), 'month'));

    if (totalNumberOfSaves === 0 || activeMonths === 0) {
        const savingsHeat = Number(0).toFixed(2);
        await redis.set(accountId, savingsHeat, 'EX', CACHE_TTL_IN_SECONDS);
        return { accountId, savingsHeat };
    }

    const avgNumberOfSavesPerMonth = totalNumberOfSaves / activeMonths;
    
    const avgGrowthInSavedAmount = await calculateGrowthInTotalAmountSaved(accountId, activeMonths);
    logger('Average savings growth for account:', avgGrowthInSavedAmount);

    const heatValues = [
        MULTIPLIERS.SAVES_PER_MONTH * avgNumberOfSavesPerMonth,
        MULTIPLIERS.SAVES_LAST_MONTH * numberOfSavesLastMonth,
        MULTIPLIERS.AVERAGE_GROWTH * avgGrowthInSavedAmount,
        numberOfSavingFriendships / 4
    ];

    const heatScore = heatValues.reduce((sum, value) => sum + value, 0);
    const roundedScore = Number(heatScore).toFixed(2); // ensures only two decimal places
    logger('Calculated heat score:', roundedScore);

    await redis.set(accountId, roundedScore, 'EX', CACHE_TTL_IN_SECONDS);

    return { accountId, savingsHeat: roundedScore };
};

/**
 * This function calculates and caches a user's saving heat score. The score is based on their savings activity as well
 * as other factors such as number of saving buddies, etc. If an empty object is recieved, the function will calculate
 * and cache savings heat scores for all accounts.
 * @param {object} event
 * @property {string} accountId Optional. The account id of the user whose savings heat score is to be calculated.
 * @property {string} floatId Optional. If provided the function will calculate and cache the savings heat score for all accounts associated with this float.
 * @property {string} clientId Optional. If provided the function will calculate and cache the savings heat score for all accounts associated with this client.
 */
module.exports.calculateSavingsHeat = async (event) => {
    try {
        const { accountIds, floatId, clientId } = opsUtil.extractParamsFromEvent(event);

        let accountIdsForCalc = [];
        if (!accountIds && !floatId && !clientId) {
            accountIdsForCalc = await persistence.fetchAccounts();
        }
    
        if (accountIds) {
            accountIdsForCalc = accountIds;
        }
    
        if (floatId || clientId) {
            if (floatId) {
                accountIdsForCalc = await persistence.findAccountsForFloat(floatId);
            }

            if (clientId) {
                accountIdsForCalc = await persistence.findAccountsForClient(clientId);
            }
        }

        const heatCalculations = accountIdsForCalc.map((account) => calculateAndCacheHeatScore(account));
        const resultOfCalculations = await Promise.all(heatCalculations);
        logger('Result of heat calculations:', resultOfCalculations);

        return { result: 'SUCCESS', details: resultOfCalculations };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', message: err.message };
    }
  
};
