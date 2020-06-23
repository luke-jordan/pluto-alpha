'use strict';

const logger = require('debug')('jupiter:factoid:main');
const config = require('config');

const persistence = require('./persistence/rds.factoids');
const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const statusOrder = ['UNCREATED', 'CREATED', 'FETCHED', 'VIEWED'];
const isStatusAfter = (statusA, statusB) => statusOrder.indexOf(statusA) < statusOrder.indexOf(statusB);

// eslint-disable-next-line no-magic-numbers
const byStatus = (factoidA, factoidB) => (isStatusAfter(factoidA.factoidStatus, factoidB.factoidStatus) ? -1 : 1);
// eslint-disable-next-line no-magic-numbers
const byPriority = (factoidA, factoidB) => (factoidA.factoidPriority > factoidB.factoidPriority ? -1 : 1);
const byViewCount = (factoidA, factoidB) => factoidA.viewCount - factoidB.viewCount;

const sortFactoids = (factoids) => factoids.sort(byStatus).sort(byPriority).sort(byViewCount);

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
            active: typeof params.active === 'boolean' ? params.active : true,
            factoidPriority: params.priority || 1
        };

        const creationResult = await persistence.addFactoid(factoid);
        logger('Result of factoid creation:', creationResult);
        
        return opsUtil.wrapResponse({ result: 'SUCCESS', creationTime: creationResult.creationTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

// The expected factoid status changes here either FETCHED or VIEWED
const handleFactoidUpdate = async (systemWideUserId, factoidId, factoidStatus) => {
    // fetch the reference to the factoid from the user-factoid join table
    const factoidUserStatuses = await persistence.fetchFactoidUserStatuses([factoidId], systemWideUserId);
    logger('Got factoid details:', factoidUserStatuses);

    // if no reference is found in the join table create one
    if (!factoidUserStatuses || factoidUserStatuses.length === 0) {
        const resultOfCreation = await persistence.createFactoidUserJoin(factoidId, systemWideUserId);
        logger('Resultof creating user-factoid join table entry:', resultOfCreation);
    }

    const initialStatus = factoidUserStatuses && factoidUserStatuses.length > 0 ? factoidUserStatuses[0].factoidStatus : 'CREATED';
    logger('Is status after:', isStatusAfter(initialStatus, factoidStatus));
    if (isStatusAfter(initialStatus, factoidStatus)) {
        const resultOfUpdate = await persistence.updateFactoidStatus(factoidId, systemWideUserId, factoidStatus);
        logger('Result of updating factoid state:', resultOfUpdate);
    }

    const incrementResult = await persistence.incrementCount(factoidId, systemWideUserId, factoidStatus);
    logger('Incrementing view/fetch count resulted in:', incrementResult);

    return factoidStatus === 'FETCHED' ? { fetchCount: incrementResult.fetchCount } : { viewCount: incrementResult.viewCount };   
};

/**
 * This function updates a factoids status for a user. 
 * @param {object} event A user, admin, or direct invocation.
 * @property {array}  factoidIds An array of factoid ids.
 * @property {string} userId The identifier of the user associated with the above factoid ids.
 * @property {string} status The new status. Valid values are FETCHED and VIEWED. 
 */
module.exports.updateFactoidStateForUser = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { factoidIds, userId, status } = event;
        const updatePromises = factoidIds.map((factoidId) => handleFactoidUpdate(userId, factoidId, status));
        const resultOfUpdate = await Promise.all(updatePromises);
        logger('Result of update:', resultOfUpdate);
        return { result: 'SUCCESS', details: resultOfUpdate };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE', details: err.message };
    }
};

// Handles batch calls from SQS to updateFactoidStateForUser as SQS may pull multiple events from from multiple users.
module.exports.handleBatchFactoidUpdates = async (sqsEvent) => {
    const sqsEvents = opsUtil.extractSQSEvents(sqsEvent);
    logger('Got SQS events: ', sqsEvents);
    return Promise.all(sqsEvents.map((event) => exports.updateFactoidStateForUser(event)));
};

/**
 * This function fetches an unread factoid for a user (or the first factoid the user ever read if new factoids are exhausted)
 * @param {object} event A user or admin event.
 */
module.exports.fetchFactoidsForUser = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;
        const uncreatedFactoids = await persistence.fetchUncreatedFactoids(systemWideUserId);
        logger('Found uncreated factoids:', uncreatedFactoids);

        if (Array.isArray(uncreatedFactoids) && uncreatedFactoids.length > 0) {
            const factoidIds = uncreatedFactoids.map((factoid) => factoid.factoidId);
            const queueEvent = {
                queueName: config.get('publishing.userEvents.factoidQueue'),
                payload: { factoidIds, userId: systemWideUserId, status: 'FETCHED' }
            };
            await publisher.queueEvents([queueEvent]);
        }
     
        const factoidsForUser = await persistence.fetchCreatedFactoids(systemWideUserId);
        logger('Got factoids for user:', factoidsForUser);
        const sortedFactoids = sortFactoids(factoidsForUser);
        logger('Sorted factoids:', sortedFactoids);

        return opsUtil.wrapResponse(sortedFactoids);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function updates a factoids properties. The only property updates allowed by the this function are
 * the factoids text, the factoids active status, and the factoids priority.
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

