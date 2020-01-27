'use strict';

const logger = require('debug')('jupiter:admin:float-handler');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds.float');
const dynamo = require('./persistence/dynamo.float');
const AWS = require('aws-sdk');

const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');
const camelCaseKeys = require('camelcase-keys');

const DESC_MAP = require('./descriptions');
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

const wrapAmount = (amount, unit, currency) => ({ amount, currency, unit });

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
        
        const floatComparisons = clientFloatItem.comparatorRates ? camelCaseKeys(clientFloatItem.comparatorRates) : {};
        
        const floatItem = {
            floatId,
            floatName: clientFloatItem.floatName,
            floatTimeZone: clientFloatItem.defaultTimezone,
            floatComparisons,
            floatBalance: wrapAmount(floatBalanceInfo.amount, floatBalanceInfo.unit, currency),
            floatMonthGrowth: wrapAmount(floatInflowInfo.amount, floatInflowInfo.unit, currency),
            bonusPoolBalance: wrapAmount(bonusPoolSum, floatBalanceInfo.unit, currency),
            bonusOutflow: wrapAmount(bonusOutflowSum, floatBalanceInfo.unit, currency),
            bonusInflowSum: wrapAmount(bonusInflowSum, floatBalanceInfo.unit, currency),
            bonusPoolIds: bonusPools.has(floatId) ? Object.keys(bonusPools.get(floatId)) : []
        };

        const clientFloats = clientResults[clientId].floats;
        clientFloats.push(floatItem);
        clientResults[clientId].floats = clientFloats;
    }

    return clientResults;
};

const transformLog = (rawLog) => {
    logger('Transforming log: ', rawLog);
    const logContext = rawLog.logContext;

    const isResolved = typeof logContext === 'object' && typeof logContext.resolved === 'boolean' && logContext.resolved;
    const isRedFlag = FLAG_ALERTS.indexOf(rawLog.logType) >= 0 && !isResolved;

    // note : we almost certainly want to convert type to description on the client (e.g., for i18n), but for now, using this
    // logger('Description ? :', DESC_MAP[rawLog.logType]);
    // logger('And the whole lot: ', DESC_MAP);
    const logDescription = DESC_MAP['floatLogs'][rawLog.logType] || rawLog.logType;
    const updatedTimeMillis = moment(rawLog.updatedTime).valueOf();

    return {
        logId: rawLog.logId,
        logType: rawLog.logType,
        updatedTimeMillis,
        logDescription,
        logContext,
        isResolved,
        isRedFlag
    };
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
module.exports.listClientsAndFloats = async (event) => {
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
    const { clientId, floatId } = params;

    const [clientFloatVars, floatBalanceRaw, floatAlerts, floatBonusPoolRaw, referralCodes] = await Promise.all([
        dynamo.fetchClientFloatVars(clientId, floatId),
        persistence.getFloatBalanceAndFlows([floatId]),
        fetchFloatAlertsIssues(clientId, floatId),
        persistence.getFloatBonusBalanceAndFlows([floatId]),
        dynamo.listReferralCodes(clientId, floatId)
    ]);

    // logger('Assembled float alerts: ', floatAlerts);
    logger('And float balance: ', floatBalanceRaw);

    const floatBalanceInfo = floatBalanceRaw.get(floatId)[clientFloatVars.currency];
    const floatBalance = wrapAmount(floatBalanceInfo.amount, floatBalanceInfo.unit, clientFloatVars.currency);
    logger('Extract float balance: ', floatBalance);

    const floatBonusPools = floatBonusPoolRaw ? floatBonusPoolRaw.get(floatId) : null;
    
    const clientFloatDetails = { ...clientFloatVars, floatBalance, floatAlerts, referralCodes, floatBonusPools };

    return adminUtil.wrapHttpResponse(clientFloatDetails);
};

// ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////// FLOAT EDITING STARTS HERE ///////////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const paramsToInclude = ['accrualRateAnnualBps', 'bonusPoolShareOfAccrual', 'clientShareOfAccrual', 'prudentialFactor'];

const stripParamsForFloat = (newParams, existingParams) => paramsToInclude.
    reduce((obj, param) => ({ ...obj, [param]: newParams[param] || existingParams[param]}), {});

const adjustFloatVariables = async ({ clientId, floatId, logReason, newParams }) => {
    if (!logReason) {
        throw new Error('Must have a reason for changing parameters');
    }

    const currentClientFloatInfo = await dynamo.fetchClientFloatVars(clientId, floatId);

    const newAccrualVars = stripParamsForFloat(newParams, currentClientFloatInfo);
    const oldAccrualVars = stripParamsForFloat(currentClientFloatInfo, currentClientFloatInfo); // extracts key ones so we can log them

    const resultOfUpdate = await dynamo.updateClientFloatVars({ clientId, floatId, newPrincipalVars: newParams });
    logger('Result of update: ', resultOfUpdate);

    const logContext = { logReason, priorState: oldAccrualVars, newState: newAccrualVars };
    const logInsertion = await persistence.insertFloatLog({ clientId, floatId, logType: 'PARAMETERS_UPDATED', logContext });

    return logInsertion;
};

// if it's to / from bonus pool or client share, just use transfer lambda
// it it's to the users, issue an appropriate instruction (bleeds into capitalization)
const allocateFloatFunds = async ({ clientId, floatId, amountDef, allocatedToDef, adminUserId, logReason }) => {
    logger('Starting off an allocation, to: ', allocatedToDef);
    const logContext = { adminUserId, amountAllocated: amountDef, logReason };
    const logId = await persistence.insertFloatLog({ clientId, floatId, logType: 'ADMIN_ALLOCATE_FUNDS', logContext });
    logger('Log inserted, carry on');

    const recipientDef = { amount: amountDef.amount, recipientType: allocatedToDef };
    if (allocatedToDef === 'BONUS_POOL') {
        const { bonusPoolSystemWideId } = await dynamo.fetchClientFloatVars(clientId, floatId);
        recipientDef.recipientId = bonusPoolSystemWideId;
    } else if (allocatedToDef === 'COMPANY_SHARE') {
        const { clientCoShareTracker } = await dynamo.fetchClientFloatVars(clientId, floatId);
        recipientDef.recipientId = clientCoShareTracker;
    }

    const recipients = [recipientDef];
    logger('Recipient for allocations: ', recipients[0]);

    const payload = {
        instructions: [{
            floatId,
            clientId,
            currency: amountDef.currency,
            unit: amountDef.unit,
            amount: amountDef.amount,
            identifier: logId,
            transactionType: 'ADMIN_BALANCE_RECON',
            relatedEntityType: 'ADMIN_INSTRUCTION',
            recipients
        }]
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
        instructions: [{
            identifier: logId,
            floatId,
            clientId,
            currency: amountDef.currency,
            unit: amountDef.unit,
            amount: amountDef.amount,
            transactionType: 'ADMIN_BALANCE_RECON',
            logType: 'ADMIN_BALANCE_RECON',
            relatedEntityType: 'ADMIN_INSTRUCTION',
            recipients: [{
                recipientId: floatId,
                amount: amountDef.amount,
                recipientType: 'FLOAT_ITSELF'
            }]
        }]
    };

    logger('Sending payload to float to adjust its amount: ', payload);
    const adjustmentInvocation = adminUtil.invokeLambda(config.get('lambdas.floatTransfer'), payload);
    const resultOfAdjustment = await lambda.invoke(adjustmentInvocation).promise();
    
    const adjustmentResultP = JSON.parse(resultOfAdjustment['Payload']);
    const adjustmentBody = JSON.parse(adjustmentResultP.body);

    logger('Body of adjustment result: ', adjustmentBody);
    const adjustmentTxId = adjustmentBody[logId]['floatTxIds'][0];

    return { logId, adjustmentTxId };
};

const accrueDifferenceToUsers = async ({ clientId, floatId, amountDef, adminUserId, logReason }) => {

    const logContext = { adminUserId, amountDistributed: amountDef, logReason };
    const logId = await persistence.insertFloatLog({ clientId, floatId, logType: 'ADMIN_DISTRIBUTE_USERS', logContext });

    const payload = {
        instructions: [{
            floatId,
            clientId,
            ...amountDef,
            identifier: logId,
            relatedEntityType: 'ADMIN_INSTRUCTION',
            recipients: [{
                recipientType: 'ALL_USERS',
                amount: amountDef.amount
            }]
        }]
    };

    logger('Sending payload to float to distribute unallocated balance: ', payload);
    const allocationInvocation = adminUtil.invokeLambda(config.get('lambdas.floatTransfer'), payload);
    const resultOfAllocation = await lambda.invoke(allocationInvocation).promise();

    const resultPayload = JSON.parse(resultOfAllocation['Payload']);
    const resultBody = JSON.parse(resultPayload.body);
    logger('Received distribute to users result: ', resultBody);

    return { numberOfAllocations: resultBody[logId]['floatTxIds'].length };
};

const markLogUnresolved = async (logId, adminUserId, reasonToReopen) => {
    if (!reasonToReopen) {
        throw new Error('Reopening an alert requires user to provide a reason');
    }
    const contextToUpdate = { resolved: false, reasonReopened: reasonToReopen, reopenedBy: adminUserId };
    return persistence.updateFloatLog({ logId, contextToUpdate });
};

const updateLogToResolved = async (logId, adminUserId, resolutionNote) => {
    // record that it was viewed, and by whom (in log context)
    if (!resolutionNote) {
        throw new Error('Resolving alert without any other action requires user to provide a reason');
    }
    const contextToUpdate = { resolved: true, resolvedByUserId: adminUserId, resolutionNote };
    logger('Updating log, with context: ', contextToUpdate);
    return persistence.updateFloatLog({ logId, contextToUpdate });
};

/**
 * Handles a variety of client-float edits, such as: (a) editing accrual rates and the like, (b) dealing with logs
 * Note: will be called from different endpoints but consolidating as single lambda
 */
module.exports.adjustClientFloat = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    try {
        const adminUserId = event.requestContext.authorizer.systemWideUserId;

        const params = adminUtil.extractEventBody(event);
        logger('Extract params for float adjustment: ', params);
        
        const { operation, clientId, floatId } = params;
        
        const priorLogId = params.logId;
        const logReason = params.reasonToLog;
        const amountDef = params.amountToProcess; 

        let operationResultForLog = null;
        let tellPersistenceLogIsResolved = false;

        switch (operation) {
            case 'RESOLVE_ALERT':
                operationResultForLog = await updateLogToResolved(priorLogId, adminUserId, logReason);
                break; // do no set boolean to true as that would cause double update
            case 'REOPEN_ALERT': 
                operationResultForLog = await markLogUnresolved(priorLogId, adminUserId, logReason);
                break; // as above
            case 'ADJUST_ACCRUAL_VARS':
                operationResultForLog = await adjustFloatVariables({ clientId, floatId, logReason, newParams: params.newAccrualVars });
                break;
            case 'ALLOCATE_FUNDS':
                operationResultForLog = await allocateFloatFunds({ clientId, floatId, amountDef, allocatedToDef: params.allocateTo, adminUserId, logReason });
                tellPersistenceLogIsResolved = true;
                break;
            case 'ADD_SUBTRACT_FUNDS':
                // just adjusts the float balance to meet the amount in the bank account, do directly
                operationResultForLog = await addOrSubtractFunds({ clientId, floatId, amountDef, adminUserId, logReason });
                tellPersistenceLogIsResolved = true;
                break;
            case 'DISTRIBUTE_TO_USERS':
                operationResultForLog = await accrueDifferenceToUsers({ clientId, floatId, amountDef, adminUserId, logReason });
                tellPersistenceLogIsResolved = true;
                break;
            default:
                logger('Error, some unknown operation, parameters : ', params);
                throw new Error('Missing or unknown operation: ', operation);
        }

        logger('Result of operation: ', operation, ' is: ', operationResultForLog);

        if (tellPersistenceLogIsResolved && priorLogId) {
            await updateLogToResolved(priorLogId, adminUserId, operationResultForLog);
        }

        // possibly also send back the updated / new client-float var package?
        const response = { result: 'SUCCESS' };

        return adminUtil.wrapHttpResponse(response);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};
