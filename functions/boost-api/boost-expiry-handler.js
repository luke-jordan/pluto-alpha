'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

if (config.get('seedrandom.active')) {
    // eslint-disable-next-line global-require
    const seedrandom = require('seedrandom');
    seedrandom(config.get('seedrandom.value'), { global: true });
}

const GAME_RESPONSE = 'GAME_RESPONSE';

const fetchAccountIdsForPooledRewards = async (redemptionBoosts) => {
    logger('Fetching account IDs for pooled rewards');
    const boostsWithPooledReward = redemptionBoosts.filter((boost) => boost.rewardParameters &&
        boost.rewardParameters.rewardType === 'POOLED');
    logger('Boosts with pooled rewards: ', boostsWithPooledReward);

    if (boostsWithPooledReward.length === 0) {
        logger('No boosts with pooled rewards, exiting');
        return [];
    }

    const boostIds = boostsWithPooledReward.map((boost) => boost.boostId);
    // todo: reduce to one call to persistence
    const pooledContributionPromises = boostIds.map((boostId) => persistence.findAccountsForPooledReward(boostId, 'BOOST_POOL_CONTRIBUTION'));
    const resultOfFetch = await Promise.all(pooledContributionPromises);
    logger('Fetching pooled rewards, result from persistence:', resultOfFetch);
    const pooledContributionMap = resultOfFetch.reduce((obj, result) => ({ ...obj, [result.boostId]: result.accountIds }), {});
    return pooledContributionMap;
};

const generateRedemptionAccountMap = async (boostId, winningAccounts) => {
    const findAccountParams = { boostIds: [boostId], accountIds: winningAccounts, status: util.ACTIVE_BOOST_STATUS };
    logger('Generating redemption account map, submitting account parameters: ', findAccountParams);

    const accountInfo = await persistence.findAccountsForBoost(findAccountParams);

    return { [boostId]: accountInfo[0].accountUserMap };
};

const checkIfAccountWinsTournament = (accountId, redemptionConditions, accountScoreList) => {
    const eventContext = { accountScoreList };
    // logger('Created event context: ', eventContext);
    const event = { eventType: 'BOOST_EXPIRED', accountId, eventContext };
    // logger('Checking for tournament win, sending in event: ', event);
    return conditionTester.testConditionsForStatus(event, redemptionConditions);
};

const sortAndRankBestScores = (boostGameLogs, accountIds) => {
    // first, create a map that has the unique highest score
    const highScoreMap = new Map();
    
    // no comparison is even possible if scores are of different types, so this can be set from first log
    const { logContext: firstLogContext } = boostGameLogs[0];
    const scoreType = typeof firstLogContext.numberTaps === 'number' ? 'NUMBER' : 'PERCENT';
    
    boostGameLogs.forEach((log) => {
        const { accountId, logContext } = log;
        const accountScore = logContext.numberTaps || logContext.percentDestroyed;
        
        if (!highScoreMap.has(accountId) || highScoreMap.get(accountId) < accountScore) {
            highScoreMap.set(accountId, accountScore);
        }
    });

    logger('High score map: ', highScoreMap);

    const sortedEntries = [...highScoreMap.values()].sort((score1, score2) => score2 - score1);
    logger('Entry scores, sorted: ', sortedEntries);

    const getAccountIdRanking = (accountId) => {
        const accountScore = highScoreMap.get(accountId);
        const gameAccountResult = { 
            accountScore,
            scoreType,
            ranking: sortedEntries.indexOf(highScoreMap.get(accountId)) + 1,
            topScore: sortedEntries[0]
        };

        // this next bit for backward compatibility (for on app itself), remove in a couple app versions
        if (scoreType === 'NUMBER') {
            gameAccountResult.numberTaps = accountScore; // leaving in temporarily for legacy
        } else {
            gameAccountResult.percentDestroyed = accountScore;
        }

        return gameAccountResult;
    };

    return accountIds.reduce((obj, accountId) => ({ ...obj, [accountId]: getAccountIdRanking(accountId) }), {});
};

const expireAccountsForBoost = async (boostId, specifiedAccountIds) => {
    const accountIds = specifiedAccountIds || null; // null makes it all of them
    logger('Expiring boost, fetching account IDs to expire: ', accountIds);
    const accountsToExpire = await persistence.findAccountsForBoost({ boostIds: [boostId], status: util.ACTIVE_BOOST_STATUS, accountIds });
    const accountMap = accountsToExpire[0].accountUserMap;
    
    const updateInstruction = { boostId, newStatus: 'EXPIRED', accountIds: Object.keys(accountMap), logType: 'STATUS_CHANGE' };
    const resultOfExpiration = await persistence.updateBoostAccountStatus([updateInstruction]);
    logger('Result of expiring boosts: ', resultOfExpiration);

    const userIds = [...new Set(Object.values(accountMap).map((entry) => entry.userId))];
    publisher.publishMultiUserEvent(userIds, 'BOOST_EXPIRED', { context: { boostId }});
};

const handleTournamentWinners = async (boost, winningAccounts) => {
    const { boostId } = boost;

    const redemptionAccountDict = await generateRedemptionAccountMap(boostId, winningAccounts);
    logger('Redemption account dict: ', redemptionAccountDict);

    const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId };
    const redemptionCall = { 
        affectedAccountsDict: redemptionAccountDict, 
        event: redemptionEvent 
    };

    if (boost.rewardParameters && boost.rewardParameters.rewardType === 'POOLED') {
        const pooledContributionMap = await fetchAccountIdsForPooledRewards([boost]);
        // todo this is going to cause trouble with random rewards but minus 20 on time and just too much to do now, so fix when 
        // we actually start using random rewards (easy fix is pass this amount to boost redemption handler)
        const { boostAmount: revisedBoostAmount } = boostRedemptionHandler.calculateBoostAmount(boost, pooledContributionMap);
        logger('Updating boost amount to: ', revisedBoostAmount);
        
        boost.boostAmount = revisedBoostAmount; // so subsequent in-memory calls are correct
        await persistence.updateBoostAmount(boost.boostId, revisedBoostAmount);

        redemptionCall.pooledContributionMap = pooledContributionMap;
    }

    redemptionCall.redemptionBoosts = [boost]; // so it has the right amount in it for things like events etc
        
    const resultOfRedemptions = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
    logger('Result of redemptions for winners: ', resultOfRedemptions);

    const redemptionUpdate = { boostId, accountIds: winningAccounts, logType: 'STATUS_CHANGE', newStatus: 'REDEEMED' };
    const resultOfRedeemUpdate = await persistence.updateBoostAccountStatus([redemptionUpdate]);
    logger('And result of redemption account update: ', resultOfRedeemUpdate);

    const winningUserIds = Object.values(redemptionAccountDict[boostId]).map((entry) => entry.userId);
    await publisher.publishMultiUserEvent(winningUserIds, 'BOOST_TOURNAMENT_WON', { context: { boostId }});
};

const handleRandomAward = async (boost) => {
    const pendingParticipants = await persistence.findAccountsForBoost({ boostIds: [boost.boostId], status: ['PENDING'] });
    logger('Got pending participants:', pendingParticipants);
    const accountIds = Object.keys(pendingParticipants[0].accountUserMap);

    const scoredAccounts = accountIds.map((accountId) => ({ [accountId]: Math.random() }));
    logger('Scored accounts:', scoredAccounts);
    const winningAccounts = accountIds.filter((accountId) => checkIfAccountWinsTournament(accountId, boost.statusConditions.REDEEMED, scoredAccounts));

    if (winningAccounts.length > 0) {
        logger('Awarding boost to accounts:', winningAccounts);
        await handleTournamentWinners(boost, winningAccounts);
    }
    
    return { statusCode: 200, boostsRedeemed: winningAccounts.length };
};

module.exports.handleExpiredBoost = async (boostId) => {
    const [boost, boostGameLogs] = await Promise.all([persistence.fetchBoost(boostId), persistence.findLogsForBoost(boostId, GAME_RESPONSE)]);
    logger('Processing boost for expiry: ', boost);

    const isBoostGame = boost.boostType === 'GAME' && boostGameLogs && boostGameLogs.length > 0;
    if (!isBoostGame && !util.isRandomAward(boost)) {
        // just expire the boosts and be done
        logger('No game logs found, expiring all');
        await expireAccountsForBoost(boostId);
        return { resultCode: 200, body: 'Not a game, or no responses' };
    }

    const { statusConditions } = boost;
    if (!statusConditions || !statusConditions.REDEEMED) {
        logger('No redemption conditions, exiting');
        await expireAccountsForBoost(boostId);
        return { resultCode: 200, body: 'No redemption condition' };
    }

    if (util.isRandomAward(boost)) {
        logger('Boost is random award, awarding accordingly');
        return handleRandomAward(boost);
    }
    
    const accountIdsThatResponded = [...new Set(boostGameLogs.map((log) => log.accountId))];
    
    logger('Account IDs with responses: ', accountIdsThatResponded);

    // not the most efficient thing in the world, but it will not happen often, and we can optimize later
    const winningAccounts = accountIdsThatResponded.filter((accountId) => checkIfAccountWinsTournament(accountId, statusConditions.REDEEMED, boostGameLogs));
    
    if (winningAccounts.length > 0) {
        logger('Handling tournament result, awarding to winners: ', winningAccounts);
        await handleTournamentWinners(boost, winningAccounts);
    }

    const allAccountMap = await persistence.findAccountsForBoost({ boostIds: [boostId], status: util.ACTIVE_BOOST_STATUS });
    const allAccountIds = Object.keys(allAccountMap[0].accountUserMap);
    
    const remainingAccounts = allAccountIds.filter((accountId) => !winningAccounts.includes(accountId));
    logger('Will expire these remaining accounts: ', remainingAccounts);
    const resultOfUpdate = await expireAccountsForBoost(boostId, remainingAccounts);
    logger('Result of expiry update: ', resultOfUpdate);

    // as above, inefficient, but to neaten up later
    const sortedAndRankedAccounts = sortAndRankBestScores(boostGameLogs, accountIdsThatResponded);
    logger('Sorted and ranked accounts: ', sortedAndRankedAccounts); 
    const resultLogs = accountIdsThatResponded.map((accountId) => ({
        boostId,
        accountId,
        logType: 'GAME_OUTCOME',
        logContext: sortedAndRankedAccounts[accountId]
    }));

    const resultOfLogInsertion = await persistence.insertBoostAccountLogs(resultLogs);
    logger('Finally, result of log insertion: ', resultOfLogInsertion);

    return { statusCode: 200, boostsRedeemed: winningAccounts.length };
};

/**
 * This function checks for boosts and tournaments to be expired. If a boost is to be expired the function
 * asserts what time type of boost it is. If it is a game or random award then the winners are awarded the boost amounts
 * and the boost is discarded/expired.
 * @param {object} event An empty event
 */
module.exports.checkForBoostsToExpire = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return opsUtil.wrapResponse({ }, 403);
        }
        
        const expiredBoosts = await persistence.expireBoosts();
        logger('Expired boosts for ', expiredBoosts.length, ' account-boost pairs');
        if (expiredBoosts.length === 0) {
            logger('No boosts to expire, returning');
            return { result: 'NO_BOOSTS' };
        }

        const resultOfBoostExpiry = await Promise.all(expiredBoosts.map((boostId) => exports.handleExpiredBoost(boostId)));
        logger('Result of boost expiry:', resultOfBoostExpiry);

        const resultOfTournEnding = await persistence.endFinishedTournaments();
        logger('Result of tournament ending:', resultOfTournEnding);
        
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return opsUtil.wrapResponse({ result: 'FAILURE' });
    }
};
