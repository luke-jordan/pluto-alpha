'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds.float');
const dynamo = require('./persistence/dynamo.float');
const AWS = require('aws-sdk');

const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');

const ALERT_DESCS = require('./descriptions');
const FLAG_ALERTS = config.get('defaults.floatAlerts.redFlagTypes');

AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

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

const transformLog = (rawLog) => {
    const logContext = rawLog.logContext;

    const isResolved = typeof logContext === 'object' && typeof logContext.resolved === 'boolean' && logContext.resolved;
    const isRedFlag = FLAG_ALERTS.indexOf(rawLog.logType) > 0 && !isResolved;

    // note : we almost certainly want to convert type to description on the client (e.g., for i18n), but for now, using this
    const logDescription = ALERT_DESCS[rawLog.logType] || rawLog.logType;
    const updatedTimeMillis = moment(rawLog.updatedTime).valueOf();

    return {
        logType: rawLog.logType,
        updatedTimeMillis,
        logDescription,
        isRedFlag,
    }
};

const fetchFloatAlertsIssues = async (clientId, floatId) => {
    const rawFloatLogs = await persistence.getFloatAlerts(clientId, floatId);
    logger('Logs from RDS: ', rawFloatLogs);
    return rawFloatLogs.map((log) => transformLog(log));
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

/**
 * Fetches the details on a client float, including, e.g., accrual rates, referral codes, also soon competitor rates
 * as well as float logs, which it scans for 'alerts' (i.e., certain types of logs)
 */
module.exports.fetchClientFloatDetails = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    const params = opsCommonUtil.extractQueryParams(event);

    const clientFloatVars = await dynamo.fetchClientFloatVars(params.clientId, params.floatId);
    logger('Assembled client float vars: ', clientFloatVars);

    const floatAlerts = await fetchFloatAlertsIssues(params.floatId);
    logger('Assembled float alerts: ', floatAlerts);

    const clientFloatDetails = { ...clientFloatVars, floatAlerts };

    return adminUtil.wrapHttpResponse(clientFloatDetails);
};

const stripParamsForFloat = (newParams, existingParams) => 
    ['accrualRateAnnualBps', 'bonusPoolShareOfAccrual', 'clientShareOfAccrual', 'prudentialFactor'].
    reduce((obj, param) => ({ ...obj, [param]: newParams[param] || existingParams[param]}), {});

const adjustFloatAccrualVars = async ({ clientId, floatId, newParams }) => {
    const currentClientFloatInfo = await dynamo.fetchClientFloatVars(clientId, floatId);
    const newAccrualVars = stripParamsForFloat(newParams, currentClientFloatInfo);
    const oldAccrualVars = stripParamsForFloat(currentClientFloatInfo, currentClientFloatInfo); // extracts key ones so we can log them

    // then do an update in dynamo
    const resultOfUpdate = await dynamo.updateClientFloatVars();
    logger('Result of update: ', resultOfUpdate);

    return { newAccrualVars, oldAccrualVars };
};

const allocateFloatFunds = async ({ clientId, floatId, amountDef, allocatedToDef, adminUserId, logReason }) => {

    logger('Starting off an allocation ...');
    const logContext = { adminUserId, amountAllocated: amountDef, logReason };
    const logId = await persistence.insertFloatLog({ clientId, floatId, logType: 'ADMIN_ALLOCATE_FUNDS', logContext });
    logger('Log inserted, carry on');

    const recipients = [{
        recipientId: allocatedToDef.id,
        amount: amountDef.amount,
        recipientType: allocatedToDef.type
    }];

    const payload = {
        floatId,
        clientId,
        currency: amountDef.currency,
        unit: amountDef.unit,
        amount: amountDef.amount,
        identifier: logId,
        relatedEntityType: 'ADMIN_INSTRUCTION',
        recipients
    };

    logger('Sending payload to float transfer: ', payload);
    const allocationLambda = adminUtil.invokeLambda(config.get('lambdas.floatTransfer'), payload);
    const resultOfTransfer = await lambda.invoke(allocationLambda).promise();
    logger('Result of transfer: ', resultOfTransfer);

    const transferPayload = JSON.parse(resultOfTransfer['Payload']);
    const transferBody = JSON.parse(transferPayload.body);

    return transferBody;
};

const addOrSubtractFunds = async ({ clientId, floatId, amountDef, adminUserId, logReason }) => {

    logger('Adding or subtracting to system balance for float');
    const logContext = { adminUserId, amountAdjusted: amountDef, logReason };
    const logId = await persistence.insertFloatLog({ clientId, floatId, logType: 'BALANCE_UPDATED_MANUALLY', logContext });

    const payload = {
        floatId,
        clientId,
        currency: amountDef.currency,
        unit: amountDef.amount,
        amount: amountDef.amount,
        identifier: logId,
        relatedEntityType: 'ADMIN_INSTRUCTION',
        recipients: [{
            recipientId: floatId,
            amount: amountDef.amount,
            recipientType: 'FLOAT_ITSELF'
        }]
    };

    logger('Sending payload to float to adjust its amount: ', payload);
    const adjustmentInvocation = adminUtil.invokeLambda(config.get('lambdas.floatTransfer'), payload);
    const resultOfAdjustment = await lambda.invoke(adjustmentInvocation).promise();
    
    const adjustmentResultP = JSON.parse(resultOfAdjustment['Payload']);
    const adjustmentBody = JSON.parse(adjustmentResultP.body);

    logger('Body of adjustment result: ', adjustmentBody);

    return adjustmentBody;
};

const accrueDifferenceToUsers = async ({ clientId, floatId, amountDef, adminUserId, logReason }) => {

    const logContext = { adminUserId, amountDistributed: amountDef, logReason };
    const logId = await persistence.insertFloatLog({ clientId, floatId, logType: 'ADMIN_DISTRIBUTE_USERS', logContext });

    const payload = {
        floatId,
        clientId,
        ...amountDef,
        identified: logId,
        relatedEntityType: 'ADMIN_INSTRUCTION',
        recipients: [{
            recipientId: 'ALL_USERS'
        }]
    };

    logger('Sending payload to float to distribute unallocated balance: ', payload);
    const allocationInvocation = adminUtil.invokeLambda(config.get('lambdas.floatTransfer'), payload);
    const resultOfAllocation = await lambda.invoke(allocationInvocation).promise();

    const resultPayload = JSON.parse(resultOfAllocation['Payload']);
    const resultBody = JSON.parse(resultPayload.body);
    logger('Received distribute to users result: ', resultBody);

    return resultBody;
};

const markLogUnresolved = async (logId, adminUserId, reasonToReopen) => {
    const contextToUpdate = { resolved: false, reasonReopened: reasonToReopen, reopenedBy: adminUserId };
    return persistence.updateFloatLog({ logId, contextToUpdate });
};

const updateLogToResolved = async (logId, adminUserId, resolutionNote) => {
    const contextToUpdate = { resolved: true, resolvedByUserId: adminUserId, resolutionNote };
    logger('Updating log, with context: ', contextToUpdate);
    return persistence.updateFloatLog({ logId, contextToUpdate });
};

/**
 * Handles a variety of client-float edits, such as: (a) editing accrual rates and the like, (b) dealing with logs
 * Note: will be called from different endpoints but consolidating as single lambda
 */
module.exports.adjustClientFloat = async (event) =>{
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    try {
        const adminUserId = event.requestContext.systemWideUserId;

        const params = adminUtil.extractEventBody(event);
        logger('Extract params for float adjustment: ', params);
        
        const { operation, clientId, floatId } = params;
        
        const priorLogId = params.logId;
        const logReason = params.reasonToLog;
        const amountDef = params.amountToProcess; 

        let response = {};
        switch (operation) {
            case 'RESOLVE_ALERT':
                // record that it was viewed, and by whom (in log context)
                if (!logReason) {
                    throw new Error('Resolving alert without any other action requires user to provide a reason');
                }
                const resultOfLog = await updateLogToResolved(priorLogId, adminUserId, logReason);
                logger('Result of log resolution: ', resultOfLog);
                break;
            case 'REOPEN_ALERT': 
                // record that it is reopened
                if (!logReason) {
                    throw new Error('Reopening an alert requires user to provide a reason');
                }
                const resultOfUpdate = await markLogUnresolved(priorLogId, adminUserId, logReason);
                logger('Completed alert reopening: ', resultOfUpdate);
                break;
            case 'ADJUST_ACCRUAL_VARS':
                const oldNewState = await adjustFloatAccrualVars({ clientId, floatId, newAccrualVars: params.newAccrualVars });
                const logContext = { logReason, priorState: oldNewState.oldAccrualVars, newState: oldNewState.newAccrualVars };
                const logInsertion = await persistence.insertFloatLog({ clientId, floatId, logType: '', logContext });
                logger('Completed, result of insertion: ', logInsertion);
                break;
            case 'ALLOCATE_FUNDS':
                // if it's to / from bonus pool or client share, just use transfer lambda
                // it it's to the users, issue an appropriate instruction (bleeds into capitalization)
                const allocatedToDef = {}; // extract from params
                const allocationResult = await allocateFloatFunds({ clientId, floatId, amountDef, allocatedToDef, adminUserId, adminUserId });
                logger('Allocated? :', allocationResult);
                response = { result: 'SUCCESS' };
                break;
            case 'ADD_SUBTRACT_FUNDS':
                // just adjusts the float balance to meet the amount in the bank account, do directly
                const adjustmentResult = await addOrSubtractFunds({ clientId, floatId, amountDef, adminUserId, logReason });
                logger('Well: ', adjustmentResult);
                response = { result: 'SUCCESS' };
                break;
            case 'DISTRIBUTE_TO_USERS':
                const distributionResult = await accrueDifferenceToUsers({ clientId, floatId, adminUserId, logReason });
                logger('Distributed: ', distributionResult);
                response = { result: 'SUCCESS' };
                break;
            default:
                logger('Error, some unknown operation, event : ', event);
                throw new Error('Missing or unknown operation: ', operation);
        }

        if (response.result === 'SUCCESS') {
            await updateLogToResolved(priorLogId, adminUserId);
        }

        return adminUtil.wrapHttpResponse(response);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
}