'use strict';

const logger = require('debug')('jupiter:admin:heat');

const persistence = require('./persistence/rds.heat');

const opsUtil = require('ops-util-common');
const adminUtil = require('./admin.util');

const updateEventHeatPairs = async (params) => {
    const { eventPointItems } = params;
    return persistence.upsertEventPointItems(eventPointItems);
};

const updateHeatPointThresholds = async (params) => {
    const { levelConfigurations } = params;
    return persistence.upsertHeatPointThresholds(levelConfigurations);
};

module.exports.writeHeatConfig = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const { operation, params } = opsUtil.extractPathAndParams(event);
        logger('Performing ', operation, ' with: ', JSON.stringify(params));

        let resultOfUpdate = null;
        if (operation === 'event') {
            resultOfUpdate = await updateEventHeatPairs(params);
            logger('Result of updating event-point pairs: ', resultOfUpdate);
        } else if (operation === 'level') {
            resultOfUpdate = await updateHeatPointThresholds(params);
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
