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
    keyPrefix: `${config.get('cache.keyPrefixes.savingHeat')}::`
});

const CACHE_TTL_IN_SECONDS = config.get('cache.ttls.savingHeat');

// Contribution factors used in calculating the savings heat score.
// AVERAGE_GROWTH multiplies the average growth in the amount a user saves.
// SAVES_PER_MONTH multiplies the users average number of saves per month.
// SAVES_LAST_MONTH multiplies the number of times a user saved last month.
const CONTRIBUTION_FACTORS = {
    'AVERAGE_GROWTH': 10,
    'SAVES_PER_MONTH': 0.5,
    'SAVES_LAST_MONTH': 0.5,
    'ACTIVE_FRIENDS': 4
};

const DEFAULT_UNIT = 'HUNDREDTH_CENT';

const calculateGrowthInTotalAmountSaved = async (accountId, activeMonths) => {
    const currency = await persistence.findMostCommonCurrency(accountId);
    logger('Most common currency:', currency);
    const [totalSavedDict, lastMonthSavedDict] = await Promise.all([
        persistence.sumTotalAmountSaved(accountId, currency, DEFAULT_UNIT),
        persistence.sumAmountSavedLastMonth(accountId, currency, DEFAULT_UNIT)
    ]);

    const { amount: totalAmountSaved } = totalSavedDict;
    const { amount: amountSavedLastMonth } = lastMonthSavedDict;

    logger(`Active months: ${activeMonths}, total saved: ${totalAmountSaved}, last month: ${amountSavedLastMonth}`);
    const avgSavedAmountPerMonth = totalAmountSaved / activeMonths;
    logger('Average saved per month:', avgSavedAmountPerMonth);
    // note : if we allow this to be negative the heat calc will be quite volatile; track if we want to do that
    return Math.max(0, (amountSavedLastMonth - avgSavedAmountPerMonth) / avgSavedAmountPerMonth);
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

    logger(`Total savings: ${totalNumberOfSaves}, and number of savings last month: ${numberOfSavesLastMonth}`);
    logger(`Account opened date: ${accountOpenedDate}, and active friendships: ${numberOfSavingFriendships}`);

    const activeMonths = Math.abs(moment(accountOpenedDate).diff(moment().startOf('month'), 'month'));

    if (totalNumberOfSaves === 0 || activeMonths === 0) {
        const savingHeat = Number(0).toFixed(2);
        await redis.set(accountId, JSON.stringify({ accountId, savingHeat }), 'EX', CACHE_TTL_IN_SECONDS);
        return { accountId, savingHeat };
    }

    const avgNumberOfSavesPerMonth = totalNumberOfSaves / activeMonths;
    
    const avgGrowthInSavedAmount = await calculateGrowthInTotalAmountSaved(accountId, activeMonths);
    logger('Average savings growth for account:', avgGrowthInSavedAmount);

    const heatValues = [
        CONTRIBUTION_FACTORS.SAVES_LAST_MONTH * numberOfSavesLastMonth,
        CONTRIBUTION_FACTORS.SAVES_PER_MONTH * avgNumberOfSavesPerMonth,
        CONTRIBUTION_FACTORS.AVERAGE_GROWTH * avgGrowthInSavedAmount,
        numberOfSavingFriendships / CONTRIBUTION_FACTORS.ACTIVE_FRIENDS
    ];
    logger('Heat values: (last mth save, avg saves, avg growth, active friends', heatValues);

    const heatScore = heatValues.reduce((sum, value) => sum + value, 0);
    const savingHeat = Number(heatScore).toFixed(2); // ensures only two decimal places
    logger('Calculated heat score:', savingHeat);

    await redis.set(accountId, JSON.stringify({ accountId, savingHeat }), 'EX', CACHE_TTL_IN_SECONDS);

    return { accountId, savingHeat };
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
module.exports.calculateSavingHeat = async (event) => {
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
