'use strict';

const logger = require('debug')('jupiter:boosts:create');
const config = require('config');

const persistence = require('./persistence/rds.admin.boost');
const util = require('./boost.util');

/**
 * Lists boosts, with optional param to restrict to currently running ones
 */
module.exports.listBoosts = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!util.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return util.unauthorizedResponse;
        }

        const params = util.extractQueryParams(event);
        logger('Listing boosts, parameters: ', params);
        const excludedTypeCategories = params.includeReferrals ? [] : ['REFERRAL::USER_CODE_USED'];
        const includeStatusCounts = typeof params.includeUserCounts === 'boolean' && params.includeStatusCounts;
        const includeExpired = typeof params.includeExpired === 'boolean' && params.includeExpired;
        
        const listBoosts = await persistence.listBoosts(excludedTypeCategories, includeStatusCounts, includeExpired);

        return listBoosts;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.errorResponse(err); 
    }
}

/**
 * Flexible method/endpoint to update a boost, more or less any parameter
 */
module.exports.updateInstruction = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!util.isUserAuthorized(userDetails)) {
            return util.unauthorizedResponse;
        }

        const params = util.extractEventBody(event);
        logger('Updating a boost according to: ', params);

        const updatedBoost = await persistence.updateBoost(params);
        logger('Result from persistence: ', updatedBoost);

        return updatedBoost;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.errorResponse(err);
    }
}