'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const persistence = require('./persistence/rds.boost');

const extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;
const extractUserDetails = (event) => event.requestContext ? event.requestContext.authorizer : null;

const ALLOWABLE_ORDINARY_USER = ['REFERRAL::USER_CODE_USED'];

const handleError = (err) => {
    logger('FATAL_ERROR: ', err);
    return { statusCode: status('Internal Server Error'), body: JSON.stringify(err.message) };
}

module.exports.createBoost = async (event) => {
    try {

        const userDetails = extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: status('Forbidden') };
        }

        const params = extractEventBody(event);
        const isOrdinaryUser = userDetails.userRole === 'ORDINARY_USER';
        if (isOrdinaryUser && ALLOWABLE_ORDINARY_USER.indexOf(params.boostTypeCategory) === -1) {
            return { statusCode: status('Forbidden'), body: 'Ordinary users cannot create boosts' };
        }

        // todo : extensive validation
        const boostType = params.boostTypeCategory.split('::')[0];
        const boostCategory = params.boostTypeCategory.split('::')[1];

        logger(`Boost type: ${boostType} and category: ${boostCategory}`);

        const boostAmountDetails = params.boostAmountOffered.split('::');
        logger('Boost amount details: ', boostAmountDetails);

        // start now if nothing provided
        const boostStartTime = params.startTimeMillis ? moment(params.startTimeMillis) : moment();
        const boostEndTime = params.endTimeMillis ? moment(params.endTimeMillis) : moment().add(config.get('time.defaultEnd.number'), config.get('time.defaultEnd.unit'));

        logger(`Boost start time: ${boostStartTime.format()} and end time: ${boostEndTime.format()}`);
        
        const instructionToRds = {
            boostType,
            boostCategory,
            boostStartTime,
            boostEndTime,
            boostAmount: parseInt(boostAmountDetails[0], 10),
            boostUnit: boostAmountDetails[1],
            boostCurrency: boostAmountDetails[2],
            fromBonusPoolId: params.boostSource.bonusPoolId,
            forClientId: params.boostSource.clientId,
            conditionClause: params.conditionClause,
            conditionValue: params.conditionValue,
            boostAudience: params.boostAudience,
            boostAudienceSelection: params.boostAudienceSelection 
        };

        // logger('Sending to persistence: ', instructionToRds);
        const resultOfCall = await persistence.insertBoost(instructionToRds);
        logger('Result of RDS call: ', resultOfCall);

        return {
            statusCode: status('Ok'),
            body: JSON.stringify(resultOfCall)
        };

    } catch (err) {
        return handleError(err);
    }

};
