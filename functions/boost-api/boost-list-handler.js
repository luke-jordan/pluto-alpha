'use strict';

const logger = require('debug')('jupiter:boosts:list');
const status = require('statuses');
const util = require('./boost.util');

const persistence = require('./persistence/rds.admin.boost');

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
        const authParams = event.requestContext.authorizer;
        if (!authParams || !authParams.systemWideUserId) {
            return util.wrapHttpResponse({ message: 'User ID not found in context' }, status('Forbidden'));
        }

        const params = util.extractQueryParams(event);
        if (params.dryRun && params.dryRun === true) {
            return util.wrapHttpResponse(util.dryRunResponse);
        }
    
        const systemWideUserId = authParams.systemWideUserId;
        const accountId = await fetchUserDefaultAccount(systemWideUserId);
        logger('Got account id:', accountId);
        if (!accountId) {
            return util.wrapHttpResponse({ message: 'No account found for this user' }, status('Forbidden'));
        }

        const listBoosts = await persistence.fetchUserBoosts(accountId);
        logger('Got boosts:', listBoosts);

        return util.wrapHttpResponse(listBoosts);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return util.wrapHttpResponse({ error: err.message }, 500);
    }
};
