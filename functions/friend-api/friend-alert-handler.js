'use strict';

const logger = require('debug')('jupiter:friends:alert');

const opsUtil = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');

const LOG_TYPES_FOR_ALERT = ['FRIENDSHIP_REQUESTED', 'FRIENDSHIP_ACCEPTED'];

/**
 * Determines if there is something new to show to the user. If so, sends it back
 */
module.exports.fetchFriendAlert = async (params, userDetails) => {
    logger('Fetching friend alert, discretionary params: ', params); // may use in future
    const { systemWideUserId } = userDetails;
    
    const pendingAlertLogs = await persistenceRead.fetchAlertLogsForUser(systemWideUserId, LOG_TYPES_FOR_ALERT);
    logger('Found pending logs: ', pendingAlertLogs);

    // hierarchy: if we have no logs, exit; if we have one log, return it; if we have multiple logs,
    // we tell the user a lot has happened, and return the log ids
    if (!pendingAlertLogs || pendingAlertLogs.length === 0) {
        return { result: 'NO_ALERTS', logIds: [] };
    }

    if (pendingAlertLogs.length === 1) {
        const persistedLog = pendingAlertLogs[0];
        const logToReturn = { logId: persistedLog.logId, logType: persistedLog.logType };
        return { result: 'SINGLE_ALERT', logIds: [persistedLog.logId], alertLog: logToReturn };
    }

    const logIds = pendingAlertLogs.map((log) => log.logId);
    const logTypes = new Set(pendingAlertLogs.map((log) => log.logType));
    const logsOfType = logTypes.size === 1 ? logTypes.values().next().value : 'MULTIPLE_TYPES';
    return { result: 'MULTIPLE_ALERTS', logIds, logsOfType };
};

/**
 * Adjusts a log (or set of them) to mark that the user has been fully alerted to them.
 */
module.exports.markAlertsViewed = async (params, userDetails) => {
    logger('Marking alerts as viewed/processed with params: ', params);
    const { logIds } = params;
    if (!logIds || logIds.length === 0) {
        return { result: 'NOTHING_TO_DO' };
    }

    const { systemWideUserId } = userDetails;
    const resultOfUpdate = await persistenceWrite.updateAlertLogsToViewedForUser(systemWideUserId, logIds);
    return { result: 'UPDATED', resultOfUpdate };
};

const dispatcher = {
    'fetch': (params, userDetails) => exports.fetchFriendAlert(params, userDetails),
    'viewed': (params, userDetails) => exports.markAlertsViewed(params, userDetails)
};

/**
 * As with request, this helps us manage API and lambda proliferation
 */
module.exports.directAlertRequest = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { operation, params } = opsUtil.extractPathAndParams(event);
        const userDetails = opsUtil.extractUserDetails(event);

        logger('Executing operation: ', operation, ' with params: ', params, ' and user details: ', userDetails);

        const operationResult = await dispatcher[operation.trim().toLowerCase()](params, userDetails);

        return { statusCode: 200, body: JSON.stringify(operationResult) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
};
