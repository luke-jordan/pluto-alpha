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
            return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
    
        const systemWideUserId = authParams.systemWideUserId;
        const accountId = await fetchUserDefaultAccount(systemWideUserId);
        logger('Got account id:', accountId);
        if (!accountId) {
            return { statusCode: status('Forbidden'), message: 'No account found for this user' };
        }

        const listBoosts = await persistence.fetchUserBoosts(accountId);
        logger('Got boosts:', listBoosts);

        return util.wrapHttpResponse(listBoosts);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};