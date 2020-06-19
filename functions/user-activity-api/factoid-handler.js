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

const handleFactoidUpdate = async (factoidId, userId, status) => {
    // fetch the reference to the factoid from the user-factoid join table
    const userFactoidDetails = await persistence.fetchFactoidDetails([factoidId], userId);
    logger('Got factoid details:', userFactoidDetails);

    // if no reference is found in the join table create one
    if (!userFactoidDetails || userFactoidDetails.length === 0) {
        const resultOfPush = await persistence.pushFactoidToUser(factoidId, userId);
        logger('Result of pushing factoid to user join table:', resultOfPush);
        return { result: 'PUSHED', factoidId, details: resultOfPush };
    }

    // if an entry exists in the user-factoid join table and the new status is VIEWED increment the view count    
    const incrementResult = await persistence.incrementCount(factoidId, userId, status);
    logger('Incrementing view/fetch count resulted in:', incrementResult);

    // if the factoid has been viewed do nothing more
    if (userFactoidDetails[0].factoidStatus === 'VIEWED') {
        return { result: 'VIEWED', factoidId, details: incrementResult };
    }

    // if the factoid status is PUSHED update it to VIEWED
    const resultOfUpdate = await persistence.updateFactoidStatus(factoidId, userId, 'VIEWED');
    logger('Result of updating factoid state:', resultOfUpdate);
    return { result: 'VIEWED', factoidId, details: resultOfUpdate };
};

/**
 * This function updates a factoids status for a user. 
 * @param {object} event A user, admin, or direct invocation.
 * @property {array} factoidIds An array of factoid ids.
 * @property {string} userId The identifier of the user associated with the above factoid ids.
 * @property {string} status The new status. Valid values are PUSHED and VIEWED. 
 */
module.exports.updateFactoidStateForUser = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { factoidIds, userId, status } = event;
        const updatePromises = factoidIds.map((factoidId) => handleFactoidUpdate(factoidId, userId, status));
        const resultOfUpdate = await Promise.all(updatePromises);
        logger('Result of update:', resultOfUpdate);
        return opsUtil.wrapResponse({ result: 'SUCCESS', details: resultOfUpdate });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

// Handles batch calls from SQS to updateFactoidStateForUser
module.exports.handleBatchFactoidUpdates = async (sqsEvent) => {
    const sqsEvents = opsUtil.extractSQSEvents(sqsEvent);
    logger('Got SQS events: ', sqsEvents);
    return Promise.all(sqsEvents.map((event) => exports.updateFactoidStateForUser(event)));
};

const sortFactoids = (factoidsToDisplay, factoidDetails, factoidType) => {
    if (factoidType === 'PUSHED') {
        // for unviewed factoids, sort by highest priority then by earliest creation date
        // eslint-disable-next-line
        factoidsToDisplay[factoidType].sort((a, b) => (a.factoidPriority < b.factoidPriority) ? 1 : (a.factoidPriority === b.factoidPriority)
            ? ((moment(a.creationTime).valueOf() > moment(b.creationTime).valueOf()) ? 1 : -1) : -1 );
        return factoidsToDisplay[factoidType];
    } else {
        // for viewed factoids sort by least viewed then by last view date
        // eslint-disable-next-line
        factoidDetails.sort((a, b) => (a.readCount > b.readCount) ? 1 : (a.readCount === b.readCount)
            ? ((moment(a.updatedTime).valueOf() > moment(b.updatedTime).valueOf()) ? 1 : -1) : -1 );
        const factoidIds = factoidDetails.map((factoid) => factoid.factoidId);
        return factoidIds.map((factoidId) => factoidsToDisplay[factoidType].filter((factoid) => factoid.factoidId === factoidId)[0]);
    }
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

        const factoidsToDisplay = {};

        // fetch unviewed factoids
        const unviewedFactoids = await persistence.fetchUnviewedFactoids(systemWideUserId);
        logger('Found unread factoids:', factoidsToDisplay);

        if (Array.isArray(unviewedFactoids) && unviewedFactoids.length > 0) {
            // if user has unviewed factoids, update the factoid status of each retrieved factoid to PUSHED
            const factoidIds = unviewedFactoids.map((factoid) => factoid.factoidId);
            const statusUpdateResult = await exports.updateFactoidStateForUser({ factoidIds, userId: systemWideUserId, status: 'PUSHED' });
            if (statusUpdateResult.statusCode !== 200) {
                throw new Error('Something went wrong updating factoid states:', JSON.parse(statusUpdateResult.body));
            }
            factoidsToDisplay['PUSHED'] = unviewedFactoids;
        } else {
            const viewedFactoids = await persistence.fetchViewedFactoids(systemWideUserId);
            logger('Found viewed factoids:', viewedFactoids);
            factoidsToDisplay['VIEWED'] = viewedFactoids;
        }

        const factoidType = Object.keys(factoidsToDisplay)[0];

        if (factoidsToDisplay[factoidType].length === 0) {
            return opsUtil.wrapResponse([]);
        }

        const factoidIds = factoidsToDisplay[factoidType].map((factoid) => factoid.factoidId);
        const factoidDetails = await persistence.fetchFactoidDetails(factoidIds, systemWideUserId);
        logger('Got factoid details:', factoidDetails);

        const sortedFactoids = sortFactoids(factoidsToDisplay, factoidDetails, factoidType);
        logger('Sorted factoids:', sortedFactoids)

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

