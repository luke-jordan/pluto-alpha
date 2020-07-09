'use strict';

// const config = require('config');
const logger = require('debug')('jupiter:messaging:prefs');

const publisher = require('publish-common');

const rdsMainUtil = require('./persistence/rds.pushsettings');

const opsUtil = require('ops-util-common');
const msgUtil = require('./msg.util');

/**
 * This function inserts a push token object into RDS. It requires that the user calling this function also owns the token.
 * An evaluation of the requestContext is run prior to token manipulation. If request context evaluation fails access is forbidden.
 * Non standared propertied are ignored during the assembly of the persistable token object.
 * @param {object} event An object containing the users id, push token provider, and the push token. Details below.
 * @property {string} userId The push tokens owner.
 * @property {string} provider The push tokens provider.
 * @property {string} token The push token.
 */
module.exports.managePushToken = async (event) => {
    try {
        const userDetails = msgUtil.extractUserDetails(event);
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const params = msgUtil.extractEventBody(event);
        logger('Got http method: ', event.httpMethod, 'and params: ', params);

        if (event.httpMethod === 'DELETE') {
            return exports.deletePushToken(event);
        }

        const pushToken = await rdsMainUtil.getPushTokens([userDetails.systemWideUserId], params.provider);
        if (typeof pushToken === 'object' && Object.keys(pushToken).length > 0) {
            const deletionResult = await rdsMainUtil.deletePushToken(params.provider, userDetails.systemWideUserId); // replace with new token?
            logger('Push token deletion resulted in:', deletionResult);
        }

        const persistablePushToken = { 
            userId: userDetails.systemWideUserId,
            pushProvider: params.provider,
            pushToken: params.token
        };

        logger('Sending to RDS: ', persistablePushToken);
        const insertionResult = await rdsMainUtil.insertPushToken(persistablePushToken);
        return { statusCode: 200, body: JSON.stringify(insertionResult[0]) }; // wrap response?

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return msgUtil.wrapHttpResponse(err.message, 500);
    }
};

/**
 * This function accepts a token provider and its owners user id. It then searches for the associated persisted token object and deletes it from the 
 * database. As during insertion, only the tokens owner can execute this action. This is implemented through request context evaluation, where the userId
 * found within the requestContext object must much the value of the tokens owner user id.
 * @param {object} event An object containing the request context object and a body object. The body contains the users system wide id and the push tokens provider.
 * @property {string} userId The tokens owner user id.
 * @property {string} provider The tokens provider.
 */
module.exports.deletePushToken = async (event) => {
    try {
        const userDetails = msgUtil.extractUserDetails(event);
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        const params = msgUtil.extractEventBody(event);
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'userId')) {
            return { statusCode: 403 };
        }
        
        const relevantUserId = params.userId || userDetails.systemWideUserId;
        const deleteParams = Reflect.has(params, 'token') ? { token: params.token, userId: relevantUserId } 
            : { provider: params.provider, userId: relevantUserId }; 
        const deletionResult = await rdsMainUtil.deletePushToken(deleteParams);
        logger('Push token deletion resulted in:', deletionResult);
        
        return {
            statusCode: 200,
            body: JSON.stringify({ result: 'SUCCESS', details: deletionResult })
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return msgUtil.wrapHttpResponse(err.message, 500);
    }
};

module.exports.setUserMessageBlock = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId')) {
            return { statusCode: 403 };
        }

        const userDetails = opsUtil.extractUserDetails(event);
        const params = opsUtil.extractParamsFromEvent(event);

        const systemWideUserId = params.systemWideUserId || userDetails.systemWideUserId;
        
        const existingBlock = await rdsMainUtil.fetchUserMsgPrefs(systemWideUserId);
        const { haltPushMessages } = params;
        
        const logContext = {};
        let logEventType = '';

        if (existingBlock) {
            const resultOfUpdate = await rdsMainUtil.updateUserMsgPreference(systemWideUserId, { haltPushMessages });
            logger('Result of updating message block: ', resultOfUpdate);
            logEventType = 'MESSAGE_BLOCK_UPDATED';
            
            const { haltPushMessages: oldBlockSetting } = existingBlock;
            logContext.priorPreferences = { haltPushMessages: oldBlockSetting };
            logContext.newPreferences = { haltPushMessages };
        } else {
            const resultOfInsert = await rdsMainUtil.insertUserMsgPreference(systemWideUserId, { haltPushMessages });
            logger('Result of message block insertion: ', resultOfInsert);
            
            logEventType = 'MESSAGE_BLOCK_SET';
            logContext.newPreferences = { haltPushMessages };
        }

        const logOptions = {
            initiator: userDetails.systemWideUserId,
            context: logContext
        };

        logger('Calling publisher, with options: ', logOptions);
        await publisher.publishUserEvent(systemWideUserId, logEventType, logOptions);

        return msgUtil.wrapHttpResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return msgUtil.wrapHttpResponse(err.message, 500);
    }
};
