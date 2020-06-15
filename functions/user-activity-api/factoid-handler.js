'use strict';

const logger = require('debug')('jupiter:factoid:main');
const persistence = require('./persistence/rds');
const opsUtil = require('ops-util-common');

/**
 * This function creates and persists a new factoid.
 * @param {object} event An admin event.
 * @property {string} text The main factoid text.
 * @property {boolean} active Optional property that can be used to create inactive factoids. All new factoids are active bby default.
 * @property {object} responseOptions An object containing the possible response options to be displayed with the factoid.
 */
module.exports.createFactoid = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (userDetails.role !== 'SYSTEM_ADMIN') {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;

        const params = opsUtil.extractParamsFromEvent(event);
        logger('Got params:', params);
        const factoid = {
            createdBy: systemWideUserId,
            title: params.title,
            body: params.text,
            active: params.active ? params.active : true
        };

        const creationResult = await persistence.addFactoid(factoid);
        logger('Result of factoid creation:', creationResult);
        
        return opsUtil.wrapResponse({ result: 'SUCCESS', creationTime: creationResult.creationTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function updates a factoids properties. The only property updates allowed by the this function are
 * the factoids text and the factoids active status.
 * @param {object} event User or admin event.
 * @property {string} text The main factoid text.
 * @property {boolean} active Can be used to activate or deactivate a factoid.
 */
module.exports.updateFactoid = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const params = opsUtil.extractParamsFromEvent(event);
        if (!params.factoidId || (!params.text && !Reflect.has(params, 'active'))) {
            return { statusCode: 400, body: `Error! 'factoidId' and either the factoids 'text' or 'active' properties are required` };
        }

        const updateParams = { factoidId: params.factoidId };
        if (params.text) {
            updateParams.body = params.text;
        }

        if (Reflect.has(params, 'active')) {
            updateParams.active = params.active;
        }
        
        const resultOfUpdate = await persistence.updateFactoid(updateParams);
        logger('Result of update:', resultOfUpdate);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updatedTime: resultOfUpdate.updatedTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function fetches an unread factoid for a user (or the first factoid the user ever read if new factoids are exhausted)
 * @param {object} event A user or admin event.
 */
module.exports.fetchFactoidForUser = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;
        logger('Got user:', systemWideUserId)
        const resultOfFetch = await persistence.fetchUnreadFactoid(systemWideUserId);
        logger('Result of fetch:', resultOfFetch);
        return opsUtil.wrapResponse(resultOfFetch);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};
