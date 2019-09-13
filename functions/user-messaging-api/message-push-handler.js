'use strict';

const logger = require('debug')('jupiter:messaging:push');

const rdsUtil = require('./persistence/rds.notifications');
const msgUtil = require('./msg.util');

/**
 * This function inserts a push token object into RDS. It requires that the user calling this function also owns the token.
 * An evaluation of the requestContext is run prior to token manipulation. If request context evaluation fails access is forbidden.
 * Non standared propertied are ignored during the assembly of the persistable token object.
 * @param {string} userId The push tokens owner.
 * @param {string} provider The push tokens provider.
 * @param {string} token The push token.
 */
module.exports.insertPushToken = async (event) => {
    try {
        const userDetails = msgUtil.extractUserDetails(event);
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const params = msgUtil.extractEventBody(event);
        logger('Got event:', params);
        // uncomment if needed. along with tests. 
        // if (userDetails.systemWideUserId !== params.userId) {
        //     return { statusCode: 403 };
        // }

        const pushToken = await rdsUtil.getPushToken(params.provider, userDetails.systemWideUserId);
        logger('Got push token:', pushToken);
        if (pushToken) {
            const deletionResult = await rdsUtil.deletePushToken(params.provider, userDetails.systemWideUserId); // replace with new token?
            logger('Push token deletion resulted in:', deletionResult);
        }

        const persistablePushToken = { 
            userId: userDetails.systemWideUserId,
            pushProvider: params.provider,
            pushToken: params.token
        };

        logger('Sending to RDS: ', persistablePushToken);
        const insertionResult = await rdsUtil.insertPushToken(persistablePushToken);
        return { statusCode: 200, body: JSON.stringify(insertionResult[0]) };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            result: 'ERROR',
            details: err.message
        };
    }
};

/**
 * This function accepts a token provider and its owners user id. It then searches for the associated persisted token object and deletes it from the 
 * database. As during insertion, only the tokens owner can execute this action. This is implemented through request context evaluation, where the userId
 * found within the requestContext object must much the value of the tokens owner user id.
 * @param {string} userId The tokens owner user id.
 * @param {string} provider The tokens provider.
 */
module.exports.deletePushToken = async (event) => {
    try {
        const userDetails = msgUtil.extractUserDetails(event);
        logger('Event: ', event);
        logger('User details: ', userDetails);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        const params = msgUtil.extractEventBody(event);
        if (userDetails.systemWideUserId !== params.userId) {
            return { statusCode: 403 };
        }
        const deletionResult = await rdsUtil.deletePushToken(params.provider, params.userId);
        logger('Push token deletion resulted in:', deletionResult);
        return {
            statusCode: 200,
            body: JSON.stringify({
                result: 'SUCCESS',
                details: deletionResult
            })
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                result: 'ERROR',
                details: err.message
            })
        };
    }
};
