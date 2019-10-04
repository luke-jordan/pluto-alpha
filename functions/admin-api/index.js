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

/**
 * Knits together a variety of data to assemble the float totals, names, etc., for the current clients & floats
 * @param {array} countriesAndClients List of countries and the clients that operate in them
 * @param {array} clientFloatItems The floats, from the flat table
 */
const assembleClientFloatData = async (countriesAndClients, clientFloatItems) => {
    logger('Assembling client float data, country clients: ', countriesAndClients);
    logger('Assembling client float data, client floats: ', clientFloatItems);

    // first, get a map of all the floats and their sums in defaults
    const floatIds = clientFloatItems.map((item) => item.floatId);
    const [floatBalances, bonusPools] = await Promise.all([persistence.getFloatBalanceAndFlows(floatIds), 
        persistence.getFloatBonusBalanceAndFlows(floatIds)]);

    logger('Fetched bonus pools: ', bonusPools);
    
    // then, key the country entries by client id
    const clientCountries = countriesAndClients.reduce((obj, item) => ({ ...obj, [item.clientId]: item }), {});
    logger('Assembled client countries dict: ', clientCountries);

    const clientResults = { };

    // todo : clean this up somewhat, as will be somewhat inefficient (and has various ordering / overwrite issues)
    for (const clientFloatItem of clientFloatItems) {
        logger('Processing float: ', clientFloatItem);

        const clientId = clientFloatItem.clientId;
        logger(`Client-float assembly, now for ${clientId}, and ${clientFloatItem.floatId}`);
        if (!Reflect.has(clientResults, clientFloatItem.clientId)) {
            clientResults[clientId] = {
                timeZone: clientCountries[clientId].timezone,
                countryCode: clientCountries[clientId].countryCode,
                clientName: clientCountries[clientId].clientName,
                floats: [] 
            };
        }

        const floatId = clientFloatItem.floatId;
        const currency = clientFloatItem.currency;
        const floatBalanceInfo = floatBalances.get(floatId)[currency];
        logger(`For ${floatId}, in ${currency}, have ${JSON.stringify(floatBalanceInfo)}`);

        const bonusPoolInfo = bonusPools.get(floatId);
        
        let bonusPoolSum = 0;
        // by definition, these are all in the same default unit as the float
        // note : this is pretty much a hack, but will do until we go multi-currency
        Object.keys(bonusPoolInfo).forEach((key) => {
            const thisPool = bonusPoolInfo[key];
            logger('Adding bonus pool: ', thisPool);
            const relevantAmount = thisPool[currency];
            bonusPoolSum += relevantAmount.amount;
        });
        
        const floatItem = {
            floatId,
            floatName: clientFloatItem.floatName,
            floatTimeZone: clientFloatItem.defaultTimezone,
            floatBalance: {
                currency,
                amount: floatBalanceInfo.amount,
                unit: floatBalanceInfo.unit
            },
            bonusPoolBalance: {
                currency,
                amount: bonusPoolSum,
                unit: floatBalanceInfo.unit
            }
        };

        const clientFloats = clientResults[clientId].floats;
        clientFloats.push(floatItem);
        clientResults[clientId].floats = clientFloats;
    }

    return clientResults;
};

module.exports.fetchClientFloatVars = async (event) => {
    if (!util.isUserAuthorized(event)) {
        return util.unauthorizedResponse;
    }

    // in time, will have to extract administered floats from user somehow (or denormalize into appropriate table)
    const [countriesAndClients, clientsAndFloats] = await Promise.all([dynamo.listCountriesClients(), dynamo.listClientFloats()]);

    const assembledResults = await assembleClientFloatData(countriesAndClients, clientsAndFloats);
    logger('Assembled client float data: ', assembledResults); 

    return util.wrapHttpResponse(assembledResults);
};
