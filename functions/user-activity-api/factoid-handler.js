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
            countryCode: params.countryCode,
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

const updateReadCount = async (systemWideUserId, factoid) => {
    const { factoidId, readCount } = factoid;
    const resultOfReadCountUpdate = await persistence.incrementReadCount(systemWideUserId, factoidId, readCount + 1);
    logger('Update result:', resultOfReadCountUpdate);
    return resultOfReadCountUpdate;
};

const findFactoidByDate = (factoids, targetDate) => factoids.filter((factoid) => moment(factoid.creationTime) === targetDate);

const getNextFactoid = (factoids, factoidDetails, ignorePriority = false, ignoreReadCount = true) => {
    const highestPriority = Math.max(...factoids.map((factoid) => factoid.factoidPriority));
    const selectedFactoids = ignorePriority ? factoids : factoids.filter((factoid) => factoid.factoidPriority === highestPriority);
    if (selectedFactoids.length === 1) {
        return selectedFactoids[0];
    }

    if (!ignoreReadCount) {
        const minReadCount = Math.min(factoidDetails.map((factoidInfo) => factoidInfo.readCount));
        const leastViewedFactoidDetails = factoidDetails.filter((factoidInfo) => factoidInfo.readCount === minReadCount);
        const earliestReadDate = Math.min(leastViewedFactoidDetails.map((factoidInfo) => moment(factoidInfo.updatedTime).valueOf()));
        const selectedFactoidId = findFactoidByDate(leastViewedFactoids, earliestReadDate).factoidId;
        return selectedFactoids.filter((factoid) => factoid.factoidId === selectedFactoidId);
    }

    const earliestFactoidDate = Math.min(selectedFactoids.map((factoid) => moment(factoid.creationTime).valueOf()));
    return findFactoidByDate(selectedFactoids, earliestFactoidDate);
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

        const factoidToDisplay = [];
        const unviewedFactoids = await persistence.fetchUnviewedFactoids(systemWideUserId);
        logger('Found unviewed factoids:', unviewedFactoids);

        if (!unviewedFactoids || unviewedFactoids.length === 0) {
           const [viewedFactoids, factoidDetails] = await persistence.fetchViewedFactoids(systemWideUserId);
           logger('Found viewed factoids:', viewedFactoids);
           factoidToDisplay.push(getNextFactoid(viewedFactoids, factoidDetails, true, false));
           await updateReadCount(systemWideUserId, factoidToDisplay);
        } else {
            factoidToDisplay.push(getNextFactoid(unviewedFactoids));
        }

        logger('Got selected factoid:', factoidToDisplay);

        return opsUtil.wrapResponse(factoidToDisplay);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function updates a factoids properties. The only property updates allowed by the this function are
 * the factoids text and the factoids active status.
 * @param {object} event User or admin event.
 * @property {string} body The main factoid text.
 * @property {boolean} active Can be used to activate or deactivate a factoid.
 * @property {number} factoidPriority Used to update the factoids priority.
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
