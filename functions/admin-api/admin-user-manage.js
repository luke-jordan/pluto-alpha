'use strict';

const logger = require('debug')('jupiter:admin:user');
const config = require('config');

const AWS = require('aws-sdk');

const persistence = require('./persistence/rds.account');
const publisher = require('publish-common');

const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');

// bringing over pattern from events handling; dependency injection would be nicer, but for now this holds, and 
// brings some order to the sprawl this is becoming

const statusHandler = require('./user/status-handler');
const transactionHandler = require('./user/transaction-handler');

AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

// duplicated from user-query but short and to the point and small price to pay
const fetchUserProfile = async (systemWideUserId, includeContactMethod = true) => {
    const profileFetchLambdaInvoke = adminUtil.invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId, includeContactMethod });
    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    return extractLambdaBody(profileFetchResult);
};

const publishUserLog = async ({ adminUserId, systemWideUserId, eventType, context }) => {
    const logOptions = { initiator: adminUserId, context };
    logger('Dispatching user log of event type: ', eventType, ', with log options: ', logOptions);
    return publisher.publishUserEvent(systemWideUserId, eventType, logOptions);
};

const handleBsheetAccUpdate = async ({ params }) => {
    const { adminUserId, systemWideUserId, accountId, newIdentifier } = params;

    logger('Updating the FinWorks (balance sheet management) identifier for the user');
    if (!accountId) {
        return opsCommonUtil.wrapResponse('Error, must pass in account ID', 400);
    }
    if (!newIdentifier) {
        return opsCommonUtil.wrapResponse('Error, must pass in newIdentifier', 400);
    }

    logger(`Updating balance sheet account for ${systemWideUserId}, setting it to ${newIdentifier}`);
    const bsheetPrefix = config.get('bsheet.prefix');
    // happens inside to prevent accidental duplication etc
    const resultOfRdsUpdate = await persistence.updateBsheetTag({ accountId, tagPrefix: bsheetPrefix, newIdentifier });
    logger('Result of RDS update: ', resultOfRdsUpdate);
    if (!resultOfRdsUpdate) {
        return { result: 'ERROR', message: 'Failed on persistence update' };
    }
    
    const oldIdentifier = resultOfRdsUpdate.oldIdentifier;
    const logContext = { performedBy: adminUserId, owningUserId: systemWideUserId, newIdentifier, oldIdentifier };

    await Promise.all([
        publishUserLog({ adminUserId, systemWideUserId, eventType: 'ADMIN_UPDATED_BSHEET_TAG', context: { ...logContext, accountId } }),
        persistence.insertAccountLog({ accountId, adminUserId, logType: 'ADMIN_UPDATED_BSHEET_TAG', logContext })
    ]);
    return { result: 'SUCCESS', updateLog: resultOfRdsUpdate };
};

const handlePwdUpdate = async ({ params }) => {
    const { adminUserId, systemWideUserId } = params;

    const authorizer = { systemWideUserId: adminUserId, role: 'SYSTEM_ADMIN' };
    const updatePayload = { systemWideUserId, generateRandom: true, requestContext: { authorizer} };
    logger('Invoking password update lambda, payload: ', updatePayload);
    const updateResult = await lambda.invoke(adminUtil.invokeLambda(config.get('lambdas.passwordUpdate'), updatePayload)).promise();
    logger('Password update result: ', updateResult);

    const resultPayload = JSON.parse(updateResult['Payload']);
    if (updateResult['StatusCode'] === 200) {
        const resultBody = JSON.parse(resultPayload.body);
        if (!Reflect.has(resultBody, 'newPassword')) {
            return { result: 'ERROR', message: 'Failed on new password generation' };
        }
        
        const { newPassword } = resultBody;
        const dispatchMsg = `Your password has been successfully reset. Please use the following ` +
            `password to login to your account: ${newPassword}. Please create a new password once logged in.`;
        const userProfile = await fetchUserProfile(systemWideUserId, true);
        
        let dispatchResult = null;

        if (config.has('defaults.pword.mock.enabled') && config.get('defaults.pword.mock.enabled')) {
            userProfile.phoneNumber = userProfile.phoneNumber ? config.get('defaults.pword.mock.phone') : null;
            userProfile.emailAddress = userProfile.emailAddress ? config.get('defaults.pword.mock.email') : null;
        }

        if (userProfile.emailAddress) {
            dispatchResult = await publisher.sendSystemEmail({
                subject: 'Jupiter Password',
                toList: [userProfile.emailAddress],
                bodyTemplateKey: config.get('email.pwdReset.templateKey'),
                templateVariables: { pwd: newPassword }
            });
        } else if (userProfile.phoneNumber) {
            dispatchResult = await publisher.sendSms({ phoneNumber: `+${userProfile.phoneNumber}`, message: dispatchMsg });
        }

        await publishUserLog({ adminUserId, systemWideUserId, eventType: 'PASSWORD_RESET', context: { dispatchResult } });

        return { result: 'SUCCESS', updateLog: { dispatchResult }};
    }
   
    return { result: 'ERROR', message: resultPayload };
};

const handleMsgPreference = async ({ params }) => {
    const { adminUserId, systemWideUserId } = params;
    const authorizer = { systemWideUserId: adminUserId, role: 'SYSTEM_ADMIN' };
    const payload = { systemWideUserId, haltPushMessages: true };
    const invocation = adminUtil.invokeLambda(config.get('lambdas.msgPrefsSet'), { requestContext: { authorizer }, body: JSON.stringify(payload) }).promise();
    logger('Invoking lambda with: ', invocation);
    const updateResult = await lambda.invoke(invocation).promise();
    logger('Result from lambda: ', updateResult);
    const responsePayload = JSON.parse(updateResult);
    return responsePayload; // should have headers etc embedded
};

// used for generic log records, especially ones involving files
// note : file here is just the name and mime type, presumption is that it is already stored
const handleLogRecord = async ({ params }) => {
    logger('Record a log for the user');
    const { adminUserId, systemWideUserId, eventType, note, file } = params;

    const context = { systemWideUserId, note, file };
    await publishUserLog({ adminUserId, systemWideUserId, eventType, context });
    
    return { result: 'SUCCESS' };
};

// used to add a flag to user account, primarily in fraud/FIC system etc
const handleFlagUpdate = async ({ params }) => {
    logger('Update user flags');
    const { systemWideUserId, flags: newFlags, adminUserId, reasonToLog } = params;
    const { accountId, flags: oldFlags } = await persistence.getAccountDetails(systemWideUserId);
    logger('Updating account ID ', accountId, ' to have flags: ', newFlags, ' used to have: ', oldFlags);

    const accountUpdateResult = await persistence.updateAccountFlags({ accountId, adminUserId, newFlags, oldFlags });
    logger('Result of persistence update: ', accountUpdateResult);

    const logContext = { accountId, oldFlags, newFlags, reasonToLog };
    await publishUserLog({ adminUserId, systemWideUserId, eventType: 'ADMIN_CHANGED_ACCOUNT_FLAGS', context: logContext });

    return { result: 'SUCCESS' };
};

const FIELD_DISPATCHER = {
    TRANSACTION: transactionHandler.processTransaction,
    KYC: statusHandler.processStatusUpdate,
    STATUS: statusHandler.processStatusUpdate,
    REGULATORY: statusHandler.processStatusUpdate,
    BSHEET: handleBsheetAccUpdate,
    PWORD: handlePwdUpdate,
    FLAGS: handleFlagUpdate,
    RECORDLOG: handleLogRecord,
    MESSAGE_PREFERENCES: handleMsgPreference
};

/**
 * @property {string} systemWideUserId The ID of the user to adjust
 * @property {string} fieldToUpdate One of: KYC, STATUS, TRANSACTION 
 */
module.exports.manageUser = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const adminUserId = opsCommonUtil.extractUserDetails(event).systemWideUserId;
        const params = { ...opsCommonUtil.extractParamsFromEvent(event), adminUserId };
        logger('Params for user management: ', params);

        if (!params.systemWideUserId || !params.fieldToUpdate || !params.reasonToLog) {
            const message = 'Requests must include a user ID to update, a field, and a reason to log';
            return opsCommonUtil.wrapResponse(message, 400);
        }

        if (!Object.keys(FIELD_DISPATCHER).includes(params.fieldToUpdate)) {
            return opsCommonUtil.wrapResponse('Error! Non-standard operation passed', 400);
        }

        logger('Standard operation received, dispatching');
        const resultOfUpdate = await FIELD_DISPATCHER[params.fieldToUpdate]({ params, lambda, publisher, persistence });
        
        // if a validation error etc., then will already have headers and relevant status code, etc.
        if (Reflect.has(resultOfUpdate, 'headers')) {
            return resultOfUpdate;
        }

        return opsCommonUtil.wrapResponse(resultOfUpdate);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};
