'use strict';

const logger = require('debug')('jupiter:boosts:list');
const config = require('config');
const moment = require('moment');

const status = require('statuses');
const util = require('./boost.util');

const opsUtil = require('ops-util-common');

const persistence = require('./persistence/rds.boost.list');

const Redis = require('ioredis');
const redis = new Redis(config.get('cache.config'));

const fetchUserDefaultAccount = async (systemWideUserId) => {
    const cacheKey = `${config.get('cache.prefix.accountId')}::${systemWideUserId}`;

    const cachedId = await redis.get(cacheKey);
    logger('Cached ID: ', cachedId);
    if (typeof cachedId === 'string' && cachedId.trim().length > 0) {
        return cachedId;
    }

    const userAccounts = await persistence.findAccountsForUser(systemWideUserId);
    logger('Retrieved accounts: ', userAccounts);
    const persistedId = Array.isArray(userAccounts) && userAccounts.length > 0 ? userAccounts[0] : null;
    if (persistedId) {
        redis.set(cacheKey, persistedId, 'EX', config.get('cache.ttl.accountId'));
    }
    return persistedId;
};

// ////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////// BOOST LISTS /////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////////////

// because this is how users expect to see it (and legacy versions of app will show bad things if this is not the case)
const convertBoostToWholeNumber = (boost) => ({
    ...boost,
    boostAmount: opsUtil.convertToUnit(boost.boostAmount, boost.boostUnit, 'WHOLE_CURRENCY'),
    boostUnit: 'WHOLE_CURRENCY'
});

const listBoostsWithParameter = async (accountId, queryParams) => {
    const fetchParameters = {};
    if (queryParams.onlyActive) {
        fetchParameters.excludedStatus = util.COMPLETE_BOOST_STATUS;
    }
    if (queryParams.flag) {
        fetchParameters.flags = [queryParams.flag];
    }
    return persistence.fetchUserBoosts(accountId, fetchParameters);
};

/**
 * This functions fetches a users boosts.
 */
module.exports.listUserBoosts = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            logger('No event! Must be warmup lambda, keep alive and continue');
            return { statusCode: 400, body: 'Empty invocation' };
        }
      
        const authParams = event.requestContext.authorizer;
        if (!authParams || !authParams.systemWideUserId) {
            return util.wrapHttpResponse({ message: 'User ID not found in context' }, status('Forbidden'));
        }
    
        const systemWideUserId = authParams.systemWideUserId;
        const accountId = await fetchUserDefaultAccount(systemWideUserId);
        logger('Got account id:', accountId);
        if (!accountId) {
            return util.wrapHttpResponse({ message: 'No account found for this user' }, status('Forbidden'));
        }

        let listBoosts = [];

        const queryParams = opsUtil.extractQueryParams(event);
        if (opsUtil.isObjectEmpty(queryParams)) {
            listBoosts = await persistence.fetchUserBoosts(accountId);
        } else {
            listBoosts = await listBoostsWithParameter(accountId, queryParams);
        }

        // logger('Got boosts:', listBoosts);

        return util.wrapHttpResponse(listBoosts);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return util.wrapHttpResponse({ error: err.message }, 500);
    }
};

// ////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////// BOOST DETAILS //////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////////////

const addLogsToBoost = (boost, boostGameLogs) => {
    boost.gameLogs = boostGameLogs ? boostGameLogs.filter((log) => log.boostId === boost.boostId) : [];
    return boost;
};

const addOutcomeLogsToGameBoosts = async (gameBoosts, allBoosts, accountId) => {
    const gameBoostIds = gameBoosts.map((boost) => boost.boostId);
    const gameLogs = await persistence.fetchUserBoostLogs(accountId, gameBoostIds, 'GAME_OUTCOME');
    const assembledGameBoosts = gameBoosts.map((boost) => addLogsToBoost(boost, gameLogs));
    const nonGameBoosts = allBoosts.filter((boost) => !gameBoostIds.includes(boost.boostId));
    return [...assembledGameBoosts, ...nonGameBoosts];
};

const obtainRedeemedOrActiveBoosts = async (accountId) => {
    // todo : make this pattern more sensible, also do some sorting
    const changeCutOff = moment().subtract(config.get('time.changeCutOff.number'), config.get('time.changeCutOff.unit'));
    const excludedForActive = ['CREATED', 'OFFERED', 'EXPIRED', 'FAILED'];
    
    const listActiveBoosts = await persistence.fetchUserBoosts(accountId, { changedSinceTime: changeCutOff, excludedStatus: excludedForActive });
    const unitConvertedBoosts = listActiveBoosts.map(convertBoostToWholeNumber);

    // if a boost has been redeemed, and it is a game, we attach game outcome logs to tell the user how they did, else just return all
    const redeemedGameBoosts = unitConvertedBoosts.filter((boost) => boost.boostStatus === 'REDEEMED' && boost.boostType === 'GAME');
    return redeemedGameBoosts.length > 0 ? addOutcomeLogsToGameBoosts(redeemedGameBoosts, unitConvertedBoosts, accountId) : unitConvertedBoosts;    
};

const obtainExpiredOrFailedBoosts = async (accountId) => {
    const expiredCutOff = moment().subtract(config.get('time.expiredCutOff.number'), config.get('time.expiredCutOff.unit'));
    logger('Fetching boosts since: ', expiredCutOff);

    const excludedForExpired = ['CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED'];
    const listExpiredBoosts = await persistence.fetchUserBoosts(accountId, { changedSinceTime: expiredCutOff, excludedStatus: excludedForExpired });
    logger('From persistence: ', listExpiredBoosts);
    const unitConvertedBoosts = listExpiredBoosts.map(convertBoostToWholeNumber);

    const expiredGameBoosts = unitConvertedBoosts.filter((boost) => boost.boostStatus === 'EXPIRED' && boost.boostType === 'GAME').
        map(convertBoostToWholeNumber);
    logger('Expired games: ', expiredGameBoosts);

    return expiredGameBoosts.length > 0 ? addOutcomeLogsToGameBoosts(expiredGameBoosts, unitConvertedBoosts, accountId) : unitConvertedBoosts;
};

/**
 * This method decides what to notify a user of
 * @param {object} event Standard AWS object
 */

module.exports.listChangedBoosts = async (event) => {
    try {
        const authParams = event.requestContext.authorizer;
        if (!authParams || !authParams.systemWideUserId) {
            return util.wrapHttpResponse({ message: 'User ID not found' }, status('Forbidden'));
        }

        const { systemWideUserId } = authParams;
        const accountId = await fetchUserDefaultAccount(systemWideUserId);

        const [listActiveBoosts, listExpiredBoosts] = await Promise.all([
            obtainRedeemedOrActiveBoosts(accountId), obtainExpiredOrFailedBoosts(accountId)
        ]);
        
        return util.wrapHttpResponse([...listActiveBoosts, ...listExpiredBoosts]);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.wrapHttpResponse({ error: err.message }, 500);
    }
};

// route to list friend tournament for user means tournament details are first; if not (i.e., admin call), then name not essential
// NOTE: this also means we use the FRIEND_PROFILE namespace (as in default config), because that caches a restricted set vs own-user cache
const obtainUserNames = async (userIds, thisUserId) => {
    const cachedProfiles = await redis.mget(userIds.map((userId) => `${config.get('cache.prefix.profile')}::${userId}`));
    logger('Cached profiles: ', cachedProfiles);
    const cachedNames = cachedProfiles.map((profile, index) => {
        logger('At index: ', index, ' profile: ', profile);
        if (!profile) {
            logger('No profile cached, return placeholder, for user ID: ', userIds[index]);
            return { userId: userIds[index], playerName: `Player ${index + 1}`};
        }
        if (profile.systemWideUserId === thisUserId) {
            return { userId: thisUserId, playerName: 'SELF' };
        }
        return { userId: profile.systemWideUserId, playerName: `${profile.calledName || profile.personalName} ${profile.familyName}`};
    });
    logger('Converting from rows: ', JSON.stringify(cachedNames));
    return opsUtil.convertRowsToMap(cachedNames, 'userId');
};

const fetchScoreLogsForBoost = async (boostId, systemWideUserId) => {
    const scoreLogs = await persistence.fetchBoostScoreLogs(boostId);
    logger('Obtained boost score logs: ', scoreLogs);
    const playerNames = await obtainUserNames(scoreLogs.map((log) => log.userId), systemWideUserId);
    logger('Retrieved player names: ', playerNames);
    const transformedLogs = scoreLogs.map((scoreLog) => ({
        playerName: playerNames[scoreLog.userId] ? playerNames[scoreLog.userId].playerName : 'Player',
        playerScore: scoreLog.gameScore
    }));
    logger('And transformed to: ', transformedLogs);
    return transformedLogs;
};

/**
 * This method provides the details of a boost, including (if a friend tournament), the score logs
 */
module.exports.fetchBoostDetails = async (event) => {
    try {
        const { systemWideUserId, role } = opsUtil.extractUserDetails(event);
        const { boostId } = opsUtil.extractQueryParams(event);

        const [userAccountId, boost] = await Promise.all([
            fetchUserDefaultAccount(systemWideUserId),
            persistence.fetchBoostDetails(boostId, true)
        ]);

        logger('Fetched boost, with participating account Ids, as: ', boost, ' and user own account ID: ', userAccountId);

        if (role !== 'SYSTEM_ADMIN' && !boost.accountIds.includes(userAccountId)) {
            logger('SECURITY_ERROR: Attempt to retrieve boost by non-participating user');
            return { statusCode: 403 };
        }

        if (role === 'SYSTEM_ADMIN' || boost.flags.includes('FRIEND_TOURNAMENT')) {
            boost.tournamentScores = await fetchScoreLogsForBoost(boostId, systemWideUserId);
        }

        logger('Returning assembled boost: ', boost);
        return util.wrapHttpResponse(boost);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.wrapHttpResponse({ error: err.message }, 500);
    }
};
