'use strict';

const logger = require('debug')('jupiter:factoid:main');
const moment = require('moment');
const persistence = require('./persistence/rds.factoids');
const opsUtil = require('ops-util-common');

/**
 * This function creates and persists a new factoid.
 * @param {object} event An admin event.
 * @property {string}  text The main factoid text.
 * @property {boolean} active Optional property that can be used to create inactive factoids. All new factoids are active by default.
 * @property {object}  responseOptions An object containing the possible response options to be displayed with the factoid.
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

const getNextFactoid = (factoids) => {
    const highestPriority = Math.max(...factoids.map((factoid) => factoid.factoidPriority));
    const selectedFactoids = factoids.filter((factoid) => factoid.factoidPriority === highestPriority);
    if (selectedFactoids.length === 1) {
        return selectedFactoids[0];
    }

    const earliestFactoidDate = Math.min(selectedFactoids.map((factoid) => moment(factoid.creatime).valueOf()));
    return selectedFactoids.filter((factoid) => moment(factoid.creationTime) === earliestFactoidDate);
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
        const factoids = await persistence.fetchUnreadFactoids(systemWideUserId);
        logger('Result of fetch:', factoids);

        const selectedFactoid = getNextFactoid(factoids);
        logger('Got selected factoid:', selectedFactoid);

        return opsUtil.wrapResponse(selectedFactoid);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function updates a factoids properties. The only property updates allowed by the this function are
 * the factoids text and the factoids active status.
 * @param {object} event User or admin event.
 * @property {string}  body The main factoid text.
 * @property {boolean} active Can be used to activate or deactivate a factoid.
 * @property {number}  factoidPriority Used to update the factoids priority.
 */
module.exports.updateFactoid = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { factoidId, body, active, priority } = opsUtil.extractParamsFromEvent(event);
        if (!factoidId || (!body && !priority && typeof active !== 'boolean')) {
            return { statusCode: 400, body: `Error! 'factoidId' and a factoid property to be updated are required` };
        }
        
        const updateParameters = JSON.parse(JSON.stringify({ factoidId, body, active, priority })); // removes keys with undefined values
        const resultOfUpdate = await persistence.updateFactoid(updateParameters);
        logger('Result of update:', resultOfUpdate);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updatedTime: resultOfUpdate.updatedTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function marks a factoid as viewed by a specified user.
 * @param {object} event A user or admin event
 * @property {string} factoidId The identifier of the factoid to be marked as viewed.
 */
module.exports.markFactoidViewed = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;
        const { factoidId } = opsUtil.extractParamsFromEvent(event);
        const resultOfUpdate = await persistence.updateFactoidToViewed(systemWideUserId, factoidId);
        logger('Result of update:', resultOfUpdate);
        return opsUtil.wrapResponse({ result: 'SUCCESS', updatedTime: resultOfUpdate.creationTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};
