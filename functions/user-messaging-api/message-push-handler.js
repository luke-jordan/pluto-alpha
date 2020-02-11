'use strict';

const config = require('config');
const logger = require('debug')('jupiter:messaging:push');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const stringify = require('json-stable-stringify');
const striptags = require('striptags');

const rdsMainUtil = require('./persistence/rds.notifications');
const rdsPickerUtil = require('./persistence/rds.msgpicker');

const msgUtil = require('./msg.util');
const msgPicker = require('./message-picking-handler');

const { Expo } = require('expo-server-sdk');
const expo = new Expo();

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

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
    logger('Received chunks: ', chunks);
    const tickets = [];

    // note : we are doing awaits within a for loop instead of consolidating into a single
    // Promise.all call, because the Expo docs suggest doing that so as to spread the load
    // see: https://github.com/expo/expo-server-sdk-node

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            logger('Received chunk: ', ticketChunk);
            tickets.push(...ticketChunk);
        } catch (err) {
            logger('Push error: ', err);
        }
    }

    return {
        channel: 'PUSH',
        result: 'SUCCESS',
        numberSent: tickets.length
    };
};

const publishMessageSentLog = ({ destinationUserId, messageId, instructionId, title, body }) => (
    publisher.publishUserEvent(destinationUserId, 'MESSAGE_PUSH_NOTIFICATION_SENT', { context: { title, body, instructionId, messageId }})
);

const sendPendingPushMsgs = async () => {
    const switchedOn = config.has('picker.push.running') && config.get('picker.push.running');
    if (!switchedOn) {
        return { channel: 'PUSH', result: 'TURNED_OFF' };
    }

    const messagesToSend = await rdsPickerUtil.getPendingOutboundMessages('PUSH');
    if (!Array.isArray(messagesToSend) || messagesToSend.length === 0) {
        return { channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 };
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

        const userLogPromises = assembledMessages.map((msg) => publishMessageSentLog(msg));
        const resultOfLogPublish = await Promise.all(userLogPromises);
        logger('Result of publishing message push logs: ', resultOfLogPublish);

        return resultOfSend;
    } catch (err) {
        // just in case, we revert, else messages never sent out
        const releaseStateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'READY_FOR_SENDING');
        logger('Result of state lock release: ', releaseStateLock);
        return { channel: 'PUSH', result: 'ERROR', message: err.message };
    }
};

const fetchUserEmail = async (systemWideUserId) => {
    const profileFetchLambdaInvoke = {
        FunctionName: config.get('lambdas.fetchProfile'),
        InvocationType: 'RequestResponse',
        Payload: stringify({ systemWideUserId, includeContactMethod: true })
    };

    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    const userProfile = JSON.parse(profileFetchResult['Payload']);
    
    return userProfile.contactType === 'EMAIL' ? { systemWideUserId, emailAddress: userProfile.contactMethod } : null;
};

const dispatchEmailMessages = async (emailMessages) => {
    logger('Fuck off and die: ', emailMessages);
    const emailInvocation = msgUtil.lambdaInvocation(config.get('lambdas.sendEmailMessages'), { emailMessages }, true);
    const resultOfSend = await lambda.invoke(emailInvocation).promise();
    logger('Result of batch email send:', resultOfSend);

    return JSON.parse(resultOfSend.Payload);
};

const sendPendingEmailMsgs = async () => {
        const messagesToSend = await rdsPickerUtil.getPendingOutboundMessages('EMAIL');
        if (!Array.isArray(messagesToSend) || messagesToSend.length === 0) {
            return { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 };
        }

        const messageIds = messagesToSend.map((msg) => msg.messageId);
        logger('Alright, processing messages: ', messageIds);
        const stateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'SENDING');
        logger('State lock done? : ', stateLock);
        
    try {
        const destinationUserIds = messagesToSend.map((msg) => msg.destinationUserId);
        const emailAddresses = await Promise.all(destinationUserIds.map((userId) => fetchUserEmail(userId)));
        const destinationMap = emailAddresses.filter((email) => email !== null)
            .reduce((obj, emailAndUserId) => ({ ...obj, [emailAndUserId.systemWideUserId]: emailAndUserId.emailAddress }), {});

        const assembledMessages = await Promise.all(messagesToSend.map((msg) => pickMessageBody(msg)));

        const messages = assembledMessages.map((msg) => ({
            messageId: msg.messageId,
            to: destinationMap[msg.destinationUserId],
            from: config.get('email.fromAddress'),
            subject: msg.title,
            text: striptags(msg.body),
            html: msg.body
        }));

        const resultOfSend = await dispatchEmailMessages(messages);
        logger('Result of email sending: ', resultOfSend);

        if (Reflect.has(resultOfSend, 'result') && resultOfSend.result === 'SUCCESS') {
            const successfulMsgs = assembledMessages.filter((msg) => !resultOfSend.failedMessageIds.includes(msg.messageId)); 
            const successfulMsgIds = messageIds.filter((msgId) => !resultOfSend.failedMessageIds.includes(msgId));

            const updateToProcessed = await rdsPickerUtil.bulkUpdateStatus(successfulMsgIds, 'SENT');
            logger('Final update worked? : ', updateToProcessed);

            const userLogPromises = successfulMsgs.map((msg) => publishMessageSentLog(msg));
            const resultOfLogPublish = await Promise.all(userLogPromises);
            logger('Result of publishing email message logs: ', resultOfLogPublish);

            return { channel: 'EMAIL', result: 'SUCCESS', numberSent: successfulMsgs.length };
        }

    } catch (err) {
        const releaseStateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'READY_FOR_SENDING');
        logger('Result of state lock release: ', releaseStateLock);
        return { channel: 'EMAIL', result: 'ERROR', message: err.message };
    }
};

// TODO THIS IS WRONG -- IT WAS SPECIFIED THAT THIS SHOULD STILL PICK THE MESSAGE ID NOT BE FREE FORM. FIX.
const sendEmailsToSpecificUsers = async (params) => {
    const destinationUserIds = params.systemWideUserIds;
    const emailAddresses = await Promise.all(destinationUserIds.map((userId) => fetchUserEmail(userId)));

    const messages = emailAddresses.map((email) => ({
        messageId: email.systemWideUserId, // allows target function to return user ids associated with failed messages
        to: email.emailAddress,
        from: config.get('email.fromAddress'),
        subject: params.title,
        text: striptags(params.body),
        html: params.body
    }));

    const resultOfSend = await dispatchEmailMessages(messages);
    logger('Result of email sending: ', resultOfSend);

    if (Reflect.has(resultOfSend, 'result') && resultOfSend.result === 'SUCCESS') {
        const successfulMsgs = destinationUserIds.filter((userId) => !resultOfSend.failedMessageIds.includes(userId));
        return { channel: 'EMAIL', result: 'SUCCESS', numberSent: successfulMsgs.length };
    }

    return { channel: 'EMAIL', result: 'ERR', message: JSON.stringify(resultOfSend) };
};

const generateFromSpecificMsgs = async (params) => {
    const destinationUserIds = params.systemWideUserIds;
    const userTokenDict = await rdsMainUtil.getPushTokens(destinationUserIds, params.provider);
    logger('Sending message per token dict: ', userTokenDict);

    const messages = destinationUserIds.filter((userId) => Reflect.has(userTokenDict, userId)).
        map((userId) => ({
            to: userTokenDict[userId],
            title: params.title,
            body: params.body
    }));

    return chunkAndSendMessages(messages);
};

/**
 * This function is responsible for sending push notifications.
 * @param {object} params An optional object containing an array of system wide user ids.
 * @property {Array} systemWideUserIds An optional array of system wide user ids who will serve as reciepients of the push notifications.
 */
module.exports.sendPushNotifications = async (params) => {
    try {
        const haveSpecificIds = typeof params === 'object' && Reflect.has(params, 'systemWideUserIds');
        logger('Sending a notification to user IDs : ', haveSpecificIds ? params.systemWideUserIds : null);
   
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
        return { channel: 'PUSH', result: 'ERR', message: err.message };
    }
};

/**
 * This function sends email messages.
 */
module.exports.sendEmailMessages = async (params) => {
    try {
        const haveSpecificIds = typeof params === 'object' && Reflect.has(params, 'systemWideUserIds');
        logger('Sending a email to user IDs : ', haveSpecificIds ? params.systemWideUserIds : null);
   
        let result = {};
        if (typeof params === 'object' && Reflect.has(params, 'systemWideUserIds')) {
            logger('Sending emails to provided specific users');
            result = await sendEmailsToSpecificUsers(params);
        } else {
            logger('No specifics given, process any pending emails');
            result = await sendPendingEmailMsgs();
        }

        logger('Completed sending email, result: ', result);
        return result;

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { channel: 'EMAIL', result: 'ERR', message: err.message };
    }
};

/**
 * Primary method. Sends push messages and emails in parallel. 
 * @param {object} params An optional object containing an array of system wide user ids. Used during push message dispatch.
 * @property {Array} systemWideUserIds An optional array of system wide user ids who will serve as reciepients of the push notifications.
 */
module.exports.sendOutboundMessages = async (params) => {
    try {
        const result = await Promise.all([exports.sendPushNotifications(params), exports.sendEmailMessages(params)]);
        logger('Result of outbound messages:', result);

        return result;

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { result: 'ERR', message: err.message };
    }
};
