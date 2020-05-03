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
    return (amountSavedLastMonth - avgSavedAmountPerMonth) / avgSavedAmountPerMonth;
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

    logger(`Total number of savings: ${totalNumberOfSaves}\nNumber of savings last month: ${numberOfSavesLastMonth}`);
    logger(`Account opened date: ${accountOpenedDate}\nActive friendships: ${numberOfSavingFriendships}`);

    const activeMonths = Math.abs(moment(accountOpenedDate).diff(moment().startOf('month'), 'month'));

    if (totalNumberOfSaves === 0 || activeMonths === 0) {
        const savingsHeat = Number(0).toFixed(2);
        await redis.set(accountId, JSON.stringify({ accountId, savingsHeat }), 'EX', CACHE_TTL_IN_SECONDS);
        return { accountId, savingsHeat };
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

    const heatScore = heatValues.reduce((sum, value) => sum + value, 0);
    const savingsHeat = Number(heatScore).toFixed(2); // ensures only two decimal places
    logger('Calculated heat score:', savingsHeat);

    await redis.set(accountId, JSON.stringify({ accountId, savingsHeat }), 'EX', CACHE_TTL_IN_SECONDS);

    return { accountId, savingsHeat };
};

const findLastActivitiesOfType = (txType, txHistory) => {
    const transactions = txHistory.filter((tx) => tx.transactionType === txType);
    if (transactions.length === 0) {
        return null;
    }

    const txDates = transactions.map((tx) => moment(tx.creationTime).valueOf());
    const latestActivity = transactions.filter((tx) => moment(tx.creationTime).valueOf() === Math.max(txDates))[0];

    return {
        lastActivityDate: latestActivity.creationTime,
        lastActivityAmount: {
            amount: latestActivity.amount,
            currency: latestActivity.currency,
            unit: latestActivity.unit
        }
    };
};

const appendLastActivityToSavingsHeat = async (savingsHeat, activitiesToInclude) => {
    const accountId = savingsHeat.accountId;
    const txHistory = await persistence.fetchTransactionsForHistory(accountId);

    activitiesToInclude.forEach((activity) => {
        const latestActivity = findLastActivitiesOfType(activity, txHistory);
        if (latestActivity) {
            savingsHeat[activity] = latestActivity;
        }
    });

    return savingsHeat;
};

/**
 * This function calculates and caches a user's saving heat score. The score is based on their savings activity as well
 * as other factors such as number of saving buddies, etc. If an empty object is recieved, the function will calculate
 * and cache savings heat scores for all accounts.
 * 
 * A note on how user activity affects the heat score: making more frequent savings, adding more saving buddies, and increasing the 
 * amount saved per month will all positively affect their savings heat. 
 * @param {object} event
 * @property {string} accountId Optional. The account id of the user whose savings heat score is to be calculated.
 * @property {string} floatId Optional. If provided the function will calculate and cache the savings heat score for all accounts associated with this float.
 * @property {string} clientId Optional. If provided the function will calculate and cache the savings heat score for all accounts associated with this client.
 * @property {array } includeLastActivityOfType An array containing the types of user activity to include with the returned savings heat.
 */
module.exports.calculateSavingsHeat = async (event) => {
    try {
        const { accountIds, floatId, clientId, includeLastActivityOfType } = opsUtil.extractParamsFromEvent(event);

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

        if (Array.isArray(includeLastActivityOfType) && includeLastActivityOfType.length > 0) {
            const activityPromises = resultOfCalculations.map((result) => appendLastActivityToSavingsHeat(result, includeLastActivityOfType));
            const savingsHeatWithLastActivity = await Promise.all(activityPromises);
            logger('Got savings heat with last activities:', savingsHeatWithLastActivity);

            return { result: 'SUCCESS', details: savingsHeatWithLastActivity };
        }

        return { result: 'SUCCESS', details: resultOfCalculations };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', message: err.message };
    }
  
};
