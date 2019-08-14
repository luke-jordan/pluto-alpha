'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const persistence = require('./persistence/rds.boost');
const AWS = require('aws-sdk');
const lambda = AWS.Lambda({ region: config.get('aws.region' )});

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
            boostAudienceSelection: params.boostAudienceSelection,
            redemptionMsgInstructions: params.redemptionMsgInstructions,
            defaultStatus: params.status || 'CREATED'
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

////////////////////////////// DEALING WITH BOOSTS ///////////////////////////////////////////

const extractFindBoostKey = (event) => {
    const persistenceKey = event.accountId ? { accountId: [event.accountId] } : { userId: [event.userId] };
    persistenceKey.status = ['OFFERED', 'PENDING'];
    persistenceKey.active = true;
    return persistenceKey;
};

const testCondition = (event, statusCondition) => {
    return true;
};

const extractStatusChangesMet = (event, boost) => {
    logger('Extracting for boost: ', boost);
    const statusConditions = boost.statusConditions;
    const conditionsMet = Object.keys(statusConditions).filter((key) => testCondition(event, statusConditions[key]));  
    return conditionsMet;
};

// note: this is only called for redeemed boosts, by definition, and only has to deal with two cases at the moment:
// either the redemption is made just for the user in question, or for the whole target of the boost, but the latter
// is only possible on 'INDIVIDUAL' or 'GROUP' boosts (eg in the case of referrals, later on, friend saving)
const generateFloatTransferInstructions = async (event, boost) => {
    let recipients = { };
    if (boost.boostAudience === 'GENERAL' || !boost.redeemAll) {
        recipients[accountId] = event.accountId;
    } else {
        const recipientList = await persistence.findPendingAccountsForBoost(boost.boostId);
        recipients = recipientList.reduce((obj, recipientId) => ({ ...obj, [recipientId]: boost.boostAmount }), {});
    }

    return {
        floatId: boost.fromFloatId,
        fromId: boost.fromBonusPoolId,
        currency: boost.boostCurrency,
        unit: boost.boostUnit,
        recipients
    };
};

const triggerFloatTransfers = async (transferInstructions) => {
    const lambdaInvocation = {
        FunctionName: config.get('lambdas.floatTransfer'),
        RequestType: 'RequestResponse',
        Payload: JSON.stringify({ instructions: transferInstructions })
    };

    const result = await lambda.invoke(lambdaInvocation);
    logger('We got: ', result);

    return JSON.parse(result.Payload);
};

const generateUpdateInstruction = async (newStatus, accountsToUpdate, logType, logContext) => {

};

const testUpdateInstruction = {
    accountId: [testReferredUser, testReferringUser],
    newStatus: 'REDEEMED',
    stillActive: false,
    logType: 'REFERRAL_REDEEMED',
    logContext: { transactionId: testSavingTxId }
};

// const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

// note: possibly in time we can put this on an SQS queue, for now using a somewhat
// generic handler for any boost relevant response (add cash, solve game, etc)
module.exports.processEvent = async (event) => {
    logger('Processing boost event: ', event);

    // first, we check if there is a pending boost for this account, or user, if we only have that
    if (!event.accountId && !event.userId) {
        return { statusCode: status('Bad request'), body: 'Function requires at least a user ID or accountID' };
    }

    const offeredOrPendingBoosts = await persistence.findBoost(extractFindBoostKey(event));
    logger('Found these open boosts: ', offeredOrPendingBoosts);

    if (!offeredOrPendingBoosts || offeredOrPendingBoosts.length === 0) {
        logger('Well, nothing found');
        return { statusCode: status('Ok'), body: JSON.stringify({ boostsTriggered: 0 })};
    }

    // for each offered or pending boost, we check if the event triggers a status change, and hence compose an object
    // whose keys are the boost IDs and whose values are the lists of statuses whose conditions have been met
    const boostStatusChangeDict = { };
    offeredOrPendingBoosts.forEach((boost) => {
        boostStatusChangeDict[boost.boostId] = extractStatusChangesMet(event, boost);
    });
        // reduce((obj, boost) => ({ ...obj, [boost.boostId]: }), {});
    logger('Status change dict: ', boostStatusChangeDict);
    
    const boostsForStatusChange = offeredOrPendingBoosts.filter((boost) => boostStatusChangeDict[boost.boostId].length !== 0);
    logger('These boosts were triggered: ', boostsForStatusChange);

    if (!boostsForStatusChange || boostsForStatusChange.length === 0) {
        logger('Boosts found, but none triggered to change, so exiting');
        return { statusCode: status('Ok'), body: JSON.stringify({ boostsTriggered: 0 })};
    }

    logger('At least one boost was triggered. First step is to tell the float to transfer from bonus pool');
    const boostsToRedeem = boostsForStatusChange.filter((boost) => boostStatusChangeDict[boost.boostId].indexOf('REDEEMED') != -1);
    const transferInstructions = await Promise.all(boostsToRedeem.map((boost) => generateFloatTransferInstructions(event, boost)));

    // first, do the float allocations. we do not parallel process this as if it goes wrong we should not proceed
    // todo : definitely need a DLQ for this guy
    if (transferInstructions.length !== 0) {
        const resultOfTransfer = await triggerFloatTransfers(transferInstructions);
        if (resultOfTransfer.statusCode !== 200) {
            // todo : DLQ !!!
            return { statusCode: status('Internal Server Error'), body: 'Agh, that was bad' };
        }
    }



};
