'use strict';

const logger = require('debug')('pluto:admin:rds');
// const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds.analytics');
const dynamo = require('./persistence/dynamo.float');

const adminUtil = require('./admin.util');
// const opsCommonUtil = require('ops-util-common');

const sumBonusPools = (bonusPoolInfo, currency) => {
    let bonusPoolSum = 0;
    if (!bonusPoolInfo || typeof bonusPoolInfo !== 'object') {
        return bonusPoolSum;
    }

    // by definition, these are all in the same default unit as the float
    // note : this is pretty much a hack, but will do until we go multi-currency
    Object.keys(bonusPoolInfo).forEach((key) => {
        const thisPool = bonusPoolInfo[key];
        logger('Adding bonus pool: ', thisPool);
        const relevantAmount = thisPool[currency];
        bonusPoolSum += relevantAmount.amount;
    });
    return bonusPoolSum;
};

const wrapAmount = (amount, unit, currency) => ({
    amount, currency, unit
});

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

    const monthStart = moment().startOf('month');
    const weekStart = moment().startOf('week');
    const present = moment();

    const NEG_FLOW_FLAG = -1;
    const POS_FLOW_FLAG = 1;

    const [floatBalances, bonusPools, floatInflows, bonusOutFlow, bonusInflow] = await Promise.all([
        persistence.getFloatBalanceAndFlows(floatIds), 
        persistence.getFloatBonusBalanceAndFlows(floatIds),
        persistence.getFloatBalanceAndFlows(floatIds, monthStart),
        persistence.getFloatBonusBalanceAndFlows(floatIds, weekStart, present, NEG_FLOW_FLAG),
        persistence.getFloatBonusBalanceAndFlows(floatIds, weekStart, present, POS_FLOW_FLAG)
    ]);

    logger('Fetched bonus pools: ', bonusPools);
    logger('Bonus pool outflow: ', bonusOutFlow);
    logger('Bonus pool inflow: ', bonusInflow);
    
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
        const floatInflowInfo = floatInflows.get(floatId)[currency];

        const bonusPoolInfo = bonusPools.get(floatId);
        const bonusPoolSum = sumBonusPools(bonusPoolInfo, currency);

        const bonusOutflowSum = sumBonusPools(bonusOutFlow.get(floatId), currency);
        const bonusInflowSum = sumBonusPools(bonusInflow.get(floatId), currency);
        
        const floatItem = {
            floatId,
            floatName: clientFloatItem.floatName,
            floatTimeZone: clientFloatItem.defaultTimezone,
            floatBalance: wrapAmount(floatBalanceInfo.amount, floatBalanceInfo.unit, currency),
            floatMonthGrowth: wrapAmount(floatInflowInfo.amount, floatInflowInfo.unit, currency),
            bonusPoolBalance: wrapAmount(bonusPoolSum, floatBalanceInfo.unit, currency),
            bonusOutflow: wrapAmount(bonusOutflowSum, floatBalanceInfo.unit, currency),
            bonusInflowSum: wrapAmount(bonusInflowSum, floatBalanceInfo.unit, currency),
            bonusPoolIds: Object.keys(bonusPools.get(floatId))
        };

        const clientFloats = clientResults[clientId].floats;
        clientFloats.push(floatItem);
        clientResults[clientId].floats = clientFloats;
    }

    return clientResults;
};


/**
 * The function fetches client float variables.
 * @param {object} event An event object containing the request context, which has information about the caller.
 * @property {object} requestContext An object containing the callers id, role, and permissions. The event will not be processed without a valid request context.
 */
module.exports.fetchClientFloatVars = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    // in time, will have to extract administered floats from user somehow (or denormalize into appropriate table)
    const [countriesAndClients, clientsAndFloats] = await Promise.all([dynamo.listCountriesClients(), dynamo.listClientFloats()]);

    const assembledResults = await assembleClientFloatData(countriesAndClients, clientsAndFloats);
    logger('Assembled client float data: ', assembledResults); 

    return adminUtil.wrapHttpResponse(assembledResults);
};
