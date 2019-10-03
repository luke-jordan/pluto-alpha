'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds.analytics');
const dynamo = require('./persistence/dynamo.float');
const util = require('./admin.util');

/**
 * Gets the user counts for the front page, usign a mix of parameters. Leaving out a parameter will invoke a default
 * If startTimeMillis is left out, default is set by config but will generally be six months ago
 * If endTimeMillis is left out, default is set to now
 * The parameters 'includeNewButNoSave' determines whether to include in the count accounts that were created in the time window
 * but have not yet had a settled save transaction. This can be useful for diagnosing drop outs
 */
module.exports.fetchUserCounts = async (event) => {
    if (!util.isUserAuthorized(event)) {
        return util.unauthorizedResponse;
    }

    const params = util.extractEventBody(event);
    logger('Finding user Ids with params: ', params);

    const defaultDaysBack = config.get('defaults.userCounts.daysBack');

    const startTime = Reflect.has(params, 'startTimeMillis') ? moment(params.startTimeMillis) : moment().subtract(defaultDaysBack, 'days');
    const endTime = Reflect.has(params, 'endTimeMillis') ? moment(params.endTimeMillis) : moment();
    const includeNoTxAccountsCreatedInWindow = typeof params.includeNewButNoSave === 'boolean' && params.includeNewButNoSave;
    
    const userIdCount = await persistence.countUserIdsWithAccounts(startTime, endTime, includeNoTxAccountsCreatedInWindow);

    logger('Obtained user count: ', userIdCount);

    return util.wrapHttpResponse({ userCount: userIdCount });
};


module.exports.fetchClientFloatVars = async (event) => {
    if (!util.isUserAuthorized(event)) {
        return util.unauthorizedResponse;
    }

    // in time, will have to extract administered floats from user somehow (or denormalize into appropriate table)

    const clientsAndFloats = await dynamo.listClientFloats();

    return util.wrapHttpResponse(clientsAndFloats);
};
