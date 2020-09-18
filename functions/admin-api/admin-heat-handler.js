'use strict';

const logger = require('debug')('jupiter:admin:heat');

const persistence = require('./persistence/rds.heat');

const opsUtil = require('ops-util-common');
const adminUtil = require('./admin.util');

const updateEventHeatPairs = async (params, adminUserId) => {
    const { eventPointItems } = params;
    return persistence.upsertEventPointItems(eventPointItems, adminUserId);
};

const updateHeatPointThresholds = async (params, adminUserId) => {
    const { levelConfigurations } = params;
    return persistence.upsertHeatPointThresholds(levelConfigurations, adminUserId);
};

module.exports.writeHeatConfig = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const { operation, params } = opsUtil.extractPathAndParams(event);
        logger('Performing ', operation, ' with: ', JSON.stringify(params));

        const { systemWideUserId: adminUserId } = opsUtil.extractUserDetails(event);

        let resultOfUpdate = null;
        if (operation === 'event') {
            resultOfUpdate = await updateEventHeatPairs(params, adminUserId);
            logger('Result of updating event-point pairs: ', resultOfUpdate);
        } else if (operation === 'level') {
            resultOfUpdate = await updateHeatPointThresholds(params, adminUserId);
            logger('Result of updating level thresholds: ', resultOfUpdate);
        }

        if (!resultOfUpdate) {
            throw Error('Unknown operation');
        }

        return opsUtil.wrapResponse(resultOfUpdate);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsUtil.wrapResponse(err, 500);
    }
};

module.exports.fetchHeatConfiguration = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const { clientId, floatId } = opsUtil.extractQueryParams(event);
        logger('Fetching heat config for client ID: ', clientId, ' and float ID: ', floatId);
        
        const [levelThresholds, eventPointItems] = await Promise.all([
            persistence.fetchHeatLevelThresholds(clientId, floatId),
            persistence.fetchEventPointItems(clientId, floatId)
        ]);

        logger('Fetched level thresholds: ', JSON.stringify(levelThresholds));
        logger('Fetched event point items: ', JSON.stringify(eventPointItems));

        const returnResult = { levelThresholds, eventPointItems };
        
        return opsUtil.wrapResponse(returnResult);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsUtil.wrapResponse(err, 500);
    }
};
