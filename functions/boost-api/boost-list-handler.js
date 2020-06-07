'use strict';

const logger = require('debug')('jupiter:boosts:list');
const config = require('config');
const moment = require('moment');

const status = require('statuses');
const util = require('./boost.util');

const opsUtil = require('ops-util-common');

const persistence = require('./persistence/rds.boost.list');

const fetchUserDefaultAccount = async (systemWideUserId) => {
    logger('Fetching user accounts for user ID: ', systemWideUserId);
    const userAccounts = await persistence.findAccountsForUser(systemWideUserId);
    logger('Retrieved accounts: ', userAccounts);
    return Array.isArray(userAccounts) && userAccounts.length > 0 ? userAccounts[0] : null;
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
            const fetchParameters = {};
            if (queryParams.onlyActive) {
                fetchParameters.excludedStatus = util.COMPLETE_BOOST_STATUS;
            }
            if (queryParams.flag) {
                fetchParameters.flags = [queryParams.flag];
            }
            listBoosts = await persistence.fetchUserBoosts(accountId, fetchParameters); 
        }

        logger('Got boosts:', listBoosts);

        return util.wrapHttpResponse(listBoosts);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return util.wrapHttpResponse({ error: err.message }, 500);
    }
};

const addLogsToBoost = (boost, boostGameLogs) => {
    boost.gameLogs = boostGameLogs.filter((log) => log.boostId === boost.boostId);
    return boost;
};

const addLogsToGameBoosts = async (gameBoosts, allBoosts, accountId) => {
    const boostIds = gameBoosts.map((boost) => boost.boostId);
    const gameLogs = await persistence.fetchUserBoostLogs(accountId, boostIds, 'GAME_OUTCOME');
    const assembledGameBoosts = gameBoosts.map((boost) => addLogsToBoost(boost, gameLogs));
    const nonGameBoosts = allBoosts.filter((boost) => boost.boostStatus !== 'REDEEMED' || boost.boostType !== 'GAME');
    return [...assembledGameBoosts, ...nonGameBoosts];
};

const obtainSortedAndLoggedActiveBoosts = async (accountId) => {
    // todo : make this pattern more sensible, also do some sorting
    const changeCutOff = moment().subtract(config.get('time.changeCutOff.number'), config.get('time.changeCutOff.unit'));
    const excludedForActive = ['CREATED', 'OFFERED', 'EXPIRED'];
    
    const listActiveBoosts = await persistence.fetchUserBoosts(accountId, { changedSinceTime: changeCutOff, excludedStatus: excludedForActive });

    // if a boost has been redeemed, and it is a game, we attach game outcome logs to tell the user how they did, else just return all
    const redeemedGameBoosts = listActiveBoosts.filter((boost) => boost.boostStatus === 'REDEEMED' && boost.boostType === 'GAME');
    return redeemedGameBoosts.length > 0 ? addLogsToGameBoosts(redeemedGameBoosts, listActiveBoosts, accountId) : listActiveBoosts;    
};

const obtainSortedAndLoggedExpiredBoosts = async (accountId) => {
    const expiredCutOff = moment().subtract(config.get('time.expiredCutOff.number'), config.get('time.expiredCutOff.unit'));        
    const excludedForExpired = ['CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED'];
    const listExpiredBoosts = await persistence.fetchUserBoosts(accountId, { changedSinceTime: expiredCutOff, excludedStatus: excludedForExpired });

    const expiredGameBoosts = listExpiredBoosts.filter((boost) => boost.boostStatus === 'EXPIRED' && boost.boostType === 'GAME');
    return expiredGameBoosts.length > 0 ? addLogsToGameBoosts(expiredGameBoosts, listExpiredBoosts, accountId) : listExpiredBoosts;
};

module.exports.listChangedBoosts = async (event) => {
    try {
        const authParams = event.requestContext.authorizer;
        if (!authParams || !authParams.systemWideUserId) {
            return util.wrapHttpResponse({ message: 'User ID not found' }, status('Forbidden'));
        }

        const { systemWideUserId } = authParams;
        const accountId = await fetchUserDefaultAccount(systemWideUserId);

        const [listActiveBoosts, listExpiredBoosts] = await Promise.all([
            obtainSortedAndLoggedActiveBoosts(accountId), obtainSortedAndLoggedExpiredBoosts(accountId)
        ]);
        
        return util.wrapHttpResponse([...listActiveBoosts, ...listExpiredBoosts]);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.wrapHttpResponse({ error: err.message }, 500);
    }
};
