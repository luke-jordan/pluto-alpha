'use strict';

const config = require('config');
const logger = require('debug')('jupiter:messaging:push');

const rdsMainUtil = require('./persistence/rds.notifications');
const rdsPickerUtil = require('./persistence/rds.msgpicker');

const msgUtil = require('./msg.util');
const msgPicker = require('./message-picking-handler');

const { Expo } = require('expo-server-sdk');
const expo = new Expo();

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
        const deletionResult = await rdsMainUtil.deletePushToken(params.provider, params.userId);
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
        return msgUtil.wrapHttpResponse(err.message, 500);
    }
};

// And this is the function that sends out all pending push notifications, it can either receive 
// an instruction with a generic set of messages, or if it is run without parameters it will scan
// the user message table and find all the notifications that are pending a send, assemble their
// messages, and send them all out (meant to run once every minute). As usual, helper methods first
const pickMessageBody = async (msg) => {
    const assembledMsg = await msgPicker.assembleMessage(msg);
    return { destinationUserId: msg.destinationUserId, ...assembledMsg };
};

const chunkAndSendMessages = async (messages) => {
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    // note : we are doing awaits within a for loop instead of consolidating into a single
    // Promise.all call, because the Expo docs suggest doing that so as to spread the load
    // see: https://github.com/expo/expo-server-sdk-node

    for (let chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            logger('Received chunk: ', ticketChunk);
            tickets.push(...ticketChunk);
        } catch (err) {
            logger('Push error: ', err)
        }
    }

    return {
        result: 'SUCCESS',
        numberSent: tickets.length
    }
};

const sendPendingPushMsgs = async () => {
    const switchedOn = config.has('picker.push.running') && config.get('picker.push.running');
    if (!switchedOn) {
        return { result: 'TURNED_OFF' };
    }

    const messagesToSend = await rdsPickerUtil.getPendingPushMessages();
    if (!Array.isArray(messagesToSend) || messagesToSend.length === 0) {
        return { result: 'NONE_PENDING', numberSent: 0 };
    }

    const messageIds = messagesToSend.map((msg) => msg.messageId);
    logger('Alright, processing messages: ', messageIds);
    const stateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'SENDING');
    logger('State lock done? : ', stateLock);

    try {
        const destinationUserIds = messagesToSend.map((msg) => msg.destinationUserId);
        const msgTokens = await rdsMainUtil.getPushTokens(destinationUserIds);

        // map might end up being quicker on this, consider in future
        const filteredMessages = messagesToSend.filter((msg) => Reflect.has(msgTokens, msg.destinationUserId));
        const assembledMessages = await Promise.all(filteredMessages.map((msg) => pickMessageBody(msg)));
        
        const messages = assembledMessages.map((msg) => ({
            to: msgTokens[msg.destinationUserId],
            title: msg.title,
            body: msg.body
        }));

        // todo : trace exactly which ones are sent
        const resultOfSend = await chunkAndSendMessages(messages);
        logger('Result of expo sending: ', resultOfSend);

        // note: strictly speaking, we should only update messages that survived the filter, i.e., 
        // where the user had a valid token. but this will muddy things quite a lot later. so we are 
        // not going to do it for now ... we might, later
        const updateToProcessed = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'SENT');
        logger('Final update worked? : ', updateToProcessed);

        return resultOfSend;
    } catch (err) {
        // just in case, we revert, else messages never sent out
        const releaseStateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'READY_FOR_SENDING');
        logger('Result of state lock release: ', releaseStateLock);
        return { result: 'ERROR', message: err.message };
    }
};

const generateFromSpecificMsgs = async (params) => {
    const destinationUserIds = params.systemWideUserIds;
    const userTokenDict = await rdsMainUtil.getPushTokens(destinationUserIds, params.provider);

    const messages = destinationUserIds.filter((userId) => Reflect.has(userTokenDict, userId)).
        map((userId) => ({
            to: userTokenDict[userId],
            title: params.title,
            body: params.body
    }));

    return chunkAndSendMessages(messages);
}

module.exports.sendPushNotifications = async (params) => {
    try {
        logger('Sending a notification to user IDs : ', typeof params === 'object' && Reflect.has(params, 'systemWideUserIds') ? params.systemWideUserId : null);
   
        let result = {};
        if (typeof params === 'object' && Reflect.has(params, 'systemWideUserIds')) {
            logger('Specific IDs provided, including messages');
            result = await generateFromSpecificMsgs(params);
        } else {
            logger('No specifics given, process and send whatever is pending');
            result = await sendPendingPushMsgs();
        }

        logger('Completed sending messages, result: ', result);
        return result;
        
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { result: 'ERR', message: err.message }
    }
};