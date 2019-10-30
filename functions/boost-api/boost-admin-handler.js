'use strict';

const logger = require('debug')('jupiter:boosts:create');
// const config = require('config');

const persistence = require('./persistence/rds.admin.boost');
const util = require('./boost.util');

/**
 * Lists boosts, with optional param to restrict to currently running ones.
 * @param {object} event An event object containing the request context and request body.
 * @property {object} requestContext An object containing the callers id, role, and permissions. The event will not be processed without a valid request context.
 * @property {boolean} includeReferrals Includes referrals when set to true.
 * @property {boolean} includeUserCounts Includes a includeUserCounts property with each returned object.
 * @property {boolean} includeExpired When set to true the resulting listing includes boosts that have expired.
 */
module.exports.listBoosts = async (event) => {
    try {
        const userDetails = util.extractUserDetails(event);
        if (!util.isUserAuthorized(userDetails, 'SYSTEM_ADMIN')) {
            return util.unauthorizedResponse;
        }

        const params = util.extractQueryParams(event);
        logger('Boost list params: ', params);

        const excludedTypeCategories = params.includeReferrals ? [] : ['REFERRAL::USER_CODE_USED', 'REFERRAL::BETA_CODE_USED'];
        const includeStatusCounts = typeof params.includeUserCounts === 'boolean' && params.includeStatusCounts;
        const includeExpired = typeof params.includeExpired === 'boolean' && params.includeExpired;
        
        const listBoosts = await persistence.listBoosts(excludedTypeCategories, includeStatusCounts, includeExpired);

        return util.wrapHttpResponse(listBoosts);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.errorResponse(err); 
    }
};

/**
 * Flexible method/endpoint to update a boost, more or less any parameter
 * @param {object} event An event object containing the request context and request body.
 * @property {object} requestContext An object containing the callers id, role, and permissions. The event will not be processed without a valid request context.
 * @property {object} body An object containing the properties to be updated and their values.
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

        return util.wrapHttpResponse(updatedBoost);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return util.errorResponse(err);
    }
};
