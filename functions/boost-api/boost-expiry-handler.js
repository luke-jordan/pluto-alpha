'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const statusCodes = require('statuses');
const config = require('config');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

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

const checkIfAccountWinsTournament = (accountId, redemptionConditions, boostLogs) => {
    const eventContext = { accountScoreList: boostLogs };
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

module.exports.handleExpiredBoost = async (boostId) => {
    const [boost, boostGameLogs] = await Promise.all([persistence.fetchBoost(boostId), persistence.findLogsForBoost(boostId, GAME_RESPONSE)]);
    logger('Processing boost for expiry: ', boost);

    if (boost.boostType !== 'GAME' || !boostGameLogs || boostGameLogs.length === 0) {
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

const accountSorter = (accountA, accountB) => Object.values(accountB)[0] - Object.values(accountA)[0];

const handleRandomReward = async (boost) => {
    const statusCondition = boost.statusConditions.REDEEMED.filter((condition) => condition.startsWith('randomly_chosen_first_N'));
    const numberOfRecipients = statusCondition[0].match(/#{(.*)}/)[1];
    const pendingParticipants = await persistence.findAccountsForBoost({ boostIds: [boost.boostId], status: ['PENDING'] });
    logger('Got pending participants:', pendingParticipants);
    const accountIds = Object.keys(pendingParticipants[0].accountUserMap);
    const scoredAccounts = accountIds.map((accountId) => ({ [accountId]: Math.random() })).sort(accountSorter);
    logger('Randomly scored accounts:', scoredAccounts);
    const accountsWithHighestScore = scoredAccounts.slice(0, numberOfRecipients);
    logger('Got reward recipients:', accountsWithHighestScore);
};

/**
 * Expires all finished tournaments if no boost id is specified. If a boost id is specified then only that boost is expired.
 * @param {object} event
 * @property {string} boostId An optional boost id can be passed in to expire and end only this specific boost. 
 */
module.exports.checkForBoostsToExpire = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId')) {
            return opsUtil.wrapResponse({ }, statusCodes('forbidden'));
        }

        const { boostId } = opsUtil.extractParamsFromEvent(event);

        if (boostId) {
            const boost = await persistence.fetchBoost(boostId);
            logger('Got boost for expiry:', boost);
            if (util.isRandomReward(boost)) {
                return handleRandomReward(boost);
            }

            if (!util.isBoostTournament(boost)) {
                return opsUtil.wrapResponse({ result: 'INVALID_TOURNAMENT' });
            }

            const isTournamentFinished = await persistence.isTournamentFinished(boostId);
            logger('Is tournament finished:', isTournamentFinished[boostId]);
            if (!isTournamentFinished[boostId]) {
                return opsUtil.wrapResponse({ result: 'TOURNAMENT_IN_PROGRESS' });
            }
        }

        const resultOfExpire = await persistence.endFinishedTournaments(boostId);
        logger('Result of expiring tournament(s):', resultOfExpire);
        if (resultOfExpire.updatedTime) {
            const scheduledCleanupInvocation = util.lambdaParameters({ specificOperations: ['EXPIRE_BOOSTS'] }, 'adminScheduled');
            const resultOfInvocation = await lambda.invoke(scheduledCleanupInvocation).promise();
            logger('Result of boost expiry invocation:', resultOfInvocation);
        }

        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return opsUtil.wrapResponse({ result: 'FAILURE' });
    }
};
