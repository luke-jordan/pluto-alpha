'use strict';

const logger = require('debug')('jupiter:messaging:push');
const config = require('config');
const uuid = require('uuid');

const publisher = require('publish-common');
// const opsUtil = require('ops-util-common');

const stringify = require('json-stable-stringify');
const striptags = require('striptags');

const rdsMainUtil = require('./persistence/rds.pushsettings');
const rdsPickerUtil = require('./persistence/rds.usermessages');

const msgUtil = require('./msg.util');
const msgPicker = require('./message-picking-handler');

const { Expo } = require('expo-server-sdk');
const expo = new Expo();

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

// These are the functions that sends out all pending push notifications, it can either receive 
// an instruction with a generic set of messages, or if it is run without parameters it will scan
// the user message table and find all the notifications that are pending a send, assemble their
// messages, and send them all out (meant to run once every minute). As usual, helper methods first

const pickMessageBody = async (msg) => {
    const assembledMsg = await msgPicker.assembleMessage(msg);
    return { destinationUserId: msg.destinationUserId, ...assembledMsg };
};

const publishMessageSentLog = ({ destinationUserId, messageId, instructionId, title, channel }) => (
    publisher.publishUserEvent(destinationUserId, 'MESSAGE_SENT', { context: { title, instructionId, messageId, channel }})
);

const filterAndMarkMessagesToSend = async (channel, pendingMessages) => {
    // since the preference is pulled from left join to table
    const blockedMessageIds = pendingMessages.filter((msg) => msg.haltPushMessages).map((msg) => msg.messageId);
    if (blockedMessageIds.length > 0) {
        await rdsPickerUtil.bulkUpdateStatus(blockedMessageIds, 'BLOCKED');
    }

    const messagesToSend = pendingMessages.filter((msg) => !msg.haltPushMessages);
    if (messagesToSend.length === 0) {
        return messagesToSend;
    }

    const messageIds = messagesToSend.map((msg) => msg.messageId);
    logger('Alright, processing messages, for channel: ', channel, ' with IDs:', messageIds);
    const stateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'SENDING');
    logger('State lock done? : ', stateLock);

    return messagesToSend;
};

// /////////////////////////////////////////////////////////////////////////////////////////
// /////////////////////////// PN HANDLING /////////////////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////

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

const sendPendingPushMsgs = async () => {
    const switchedOn = config.has('picker.push.running') && config.get('picker.push.running');
    if (!switchedOn) {
        return { channel: 'PUSH', result: 'TURNED_OFF' };
    }

    const pendingMessages = await rdsPickerUtil.getPendingOutboundMessages('PUSH');
    if (!Array.isArray(pendingMessages) || pendingMessages.length === 0) {
        return { channel: 'PUSH', result: 'NONE_PENDING', numberSent: 0 };
    }

    const messagesToSend = await filterAndMarkMessagesToSend('PUSH', pendingMessages);
    if (messagesToSend.length === 0) {
        return { channel: 'PUSH', result: 'SUCCESS', numberSent: 0 };
    }
    
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
        const updateToProcessed = await rdsPickerUtil.bulkUpdateStatus(messagesToSend.map(({ messageId }) => messageId), 'SENT');
        logger('Final update worked? : ', updateToProcessed);

        const userLogPromises = assembledMessages.map((msg) => publishMessageSentLog({ ...msg, channel: 'PUSH_NOTIFICATION' }));
        const resultOfLogPublish = await Promise.all(userLogPromises);
        logger('Result of publishing message push logs: ', resultOfLogPublish);

        return resultOfSend;
    } catch (err) {
        // just in case, we revert, else messages never sent out (but this is leading to bad outcomes, i.e., repeat pings, so removing)
        // const releaseStateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'READY_FOR_SENDING');
        // logger('Result of state lock release: ', releaseStateLock);
        logger('FATAL_ERROR: ', err);
        return { channel: 'PUSH', result: 'ERROR', message: err.message };
    }
};

// ///////////////////////////////////////////////////////////////////////////////////////////
// /////////////////////////// EMAIL HANDLER /////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////

// note : as this can sometimes be changed, and quite sensitive, not using cache
const fetchUserContactDetail = async (destinationUserId) => {
    const profileFetchLambdaInvoke = {
        FunctionName: config.get('lambdas.fetchProfile'),
        InvocationType: 'RequestResponse',
        Payload: stringify({ systemWideUserId: destinationUserId, includeContactMethod: true })
    };

    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    // logger('Raw profile fetch result: ', profileFetchResult);
    const profilePayload = JSON.parse(profileFetchResult['Payload']);
    const userProfile = JSON.parse(profilePayload.body);
    // logger('User profile fetch result: ', userProfile);
    
    const result = { destinationUserId };
    if (Reflect.has(userProfile, 'emailAddress')) {
        result.emailAddress = userProfile.emailAddress;
    }

    if (Reflect.has(userProfile, 'phoneNumber')) {
        result.phoneNumber = userProfile.phoneNumber;
    }

    return result;
};

const dispatchEmailMessages = async (emailMessages) => {
    // logger('Dispatching these email messages: ', emailMessages);
    logger(`Dispatching ${emailMessages.length} email messages, wrapper enabled: ${config.get('email.wrapper.enabled')}`);
    const payload = { emailMessages };
    if (typeof config.get('email.wrapper.enabled') === 'boolean' && config.get('email.wrapper.enabled')) {
        payload.emailWrapper = {
            s3bucket: config.get('email.wrapper.bucket'),
            s3key: config.get('email.wrapper.key')
        };
    }

    logger('Sending payload to outbound comms: ', payload);
    const emailInvocation = msgUtil.lambdaInvocation(config.get('lambdas.sendOutboundMessages'), payload, true);
    const resultOfSend = await lambda.invoke(emailInvocation).promise();
    logger('Result of batch email send:', resultOfSend);

    return JSON.parse(resultOfSend.Payload);
};

const handleLogPublishing = async ({ sentMessages, rawMessages, emailResult }) => {
    // we currently assume all SMSs are sent (they are async dispatched), or at least market to avoid repeat

    const anythingFailed = Array.isArray(emailResult.failedMessageIds) && emailResult.failedMessageIds.length > 0;
    const successFilter = (messageId) => !anythingFailed || !emailResult.failedMessageIds.includes(messageId);
    
    const successfulMsgs = rawMessages.filter((msg) => successFilter(msg.messageId)); 
    const successfulMsgIds = successfulMsgs.map((msg) => msg.messageId);

    logger('Updating messages to sent: ', successfulMsgIds);
    const updateToProcessed = await rdsPickerUtil.bulkUpdateStatus(successfulMsgIds, 'SENT');
    logger('Final update worked? : ', updateToProcessed);

    const emailFilter = (sentMsg) => sentMsg !== null && !Reflect.has(sentMsg, 'phoneNumber');
    const emailIds = sentMessages.filter(emailFilter).map((msg) => msg.messageId);
    const successfulEmails = successfulMsgs.filter((msg) => emailIds.includes(msg.messageId));
    
    // note : we are not going to include body because that sometimes has sensitive information (e.g., balances)
    const mapMessageToLog = (msg, channel) => ({ 
        destinationUserId: msg.destinationUserId,
        messageId: msg.messageId,
        title: msg.title,
        instructionId: msg.instructionId,
        channel
    });

    const emailLogs = successfulEmails.map((msg) => publishMessageSentLog(mapMessageToLog(msg, 'EMAIL')));
    const smsLogs = successfulMsgs.filter((msg) => !emailIds.includes(msg.messageId)).
        map((msg) => publishMessageSentLog(mapMessageToLog(msg, 'SMS')));
    
    const resultOfLogPublish = await Promise.all([...emailLogs, ...smsLogs]);
    logger('Result of publishing email & SMS message logs: ', resultOfLogPublish);

    return successfulMsgs.length;
};

// In the event of a message being sent to a user without an email, an sms back up message is sent to the user.
// This sms message is found in the message display property (backupSms in the template)
const sendPendingEmailMsgs = async () => {
    const batchSize = config.get('email.batchSize');

    const pendingMessages = await rdsPickerUtil.getPendingOutboundMessages('EMAIL', batchSize);
    if (!Array.isArray(pendingMessages) || pendingMessages.length === 0) {
        return { channel: 'EMAIL', result: 'NONE_PENDING', numberSent: 0 };
    }

    const messagesToSend = await filterAndMarkMessagesToSend('EMAIL', pendingMessages);
    if (messagesToSend.length === 0) {
        return { channel: 'EMAIL', result: 'SUCCESS', numberSent: 0 };
    }
    
    try {
        const destinationUserIds = messagesToSend.map((msg) => msg.destinationUserId);
        const userContactDetails = await Promise.all(destinationUserIds.map((userId) => fetchUserContactDetail(userId)));
        const mappedContacts = userContactDetails.reduce((map, profile) => ({ ...map, [profile.destinationUserId]: { ...profile }}), {});

        const assembledMessages = await Promise.all(messagesToSend.map((msg) => pickMessageBody(msg)));
        // logger('And assembled messages: ', assembledMessages);
        
        const messages = assembledMessages.map((msg) => {
            // logger('Creating lambda invocation from assembled message: ', msg);
            logger('Mapped contact: ', mappedContacts[msg.destinationUserId]);
            if (mappedContacts[msg.destinationUserId].emailAddress) {
                return {
                    messageId: msg.messageId,
                    to: mappedContacts[msg.destinationUserId].emailAddress,
                    from: config.get('email.fromAddress'),
                    subject: msg.title,
                    text: striptags(msg.body),
                    html: msg.body
                };
            }

            if (msg.display && msg.display.backupSms) {
                return {
                    phoneNumber: `+${mappedContacts[msg.destinationUserId].phoneNumber}`,
                    message: msg.display.backupSms
                };
            }

            return null;
        });
        
        const emailFilter = (msg) => msg !== null && !Reflect.has(msg, 'phoneNumber');
        const emailResult = await dispatchEmailMessages(messages.filter(emailFilter));
        logger('Result of email dispatch', emailResult);

        const phoneFilter = (msg) => msg !== null && Reflect.has(msg, 'phoneNumber');
        const smsResults = await Promise.all(messages.filter(phoneFilter).map((sms) => publisher.sendSms(sms)));
        logger('Result of sms dispatch', smsResults);
 
        // todo : fix this to also set to "sent" the ones with just SMSs or no email address or SMS
        const emailSuccess = emailResult && emailResult.result === 'SUCCESS';
        const smsSuccess = smsResults && smsResults.some(({ result }) => result === 'SUCCESS');
        logger(`Email success?  : ${emailSuccess}, and SMS success ? : ${smsSuccess}`);
        
        if (emailSuccess || smsSuccess) {
            const successfulMsgs = await handleLogPublishing({ sentMessages: messages, rawMessages: assembledMessages, emailResult });
            return { channel: 'EMAIL', result: 'SUCCESS', numberSent: successfulMsgs };
        }

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        // const releaseStateLock = await rdsPickerUtil.bulkUpdateStatus(messageIds, 'READY_FOR_SENDING');
        // logger('Result of state lock release: ', releaseStateLock);
        return { channel: 'EMAIL', result: 'ERROR', message: err.message };
    }
};

// ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////////////// SECTION: SEND TO SPECIFIED USERS ///////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const sendEmailsToSpecificUsers = async (destinationUserIds, params) => {
    const userContactDetails = await Promise.all(destinationUserIds.map((userId) => fetchUserContactDetail(userId)));
    logger('Got mapped contacts:', userContactDetails);

    const messages = userContactDetails.map((contact) => {
        if (contact.emailAddress) {
            return {
                messageId: params.messageId || uuid(),
                to: contact.emailAddress,
                from: config.get('email.fromAddress'),
                subject: params.title,
                text: striptags(params.body),
                html: params.body
            };
        }

        if (params.backupSms) {
            return {
                phoneNumber: `+${contact.phoneNumber}`,
                message: params.backupSms
            };
        }

        return {};
    });

    const resultOfSend = await dispatchEmailMessages(messages.filter((msg) => !Reflect.has(msg, 'phoneNumber')));
    logger('Result of email sending: ', resultOfSend);

    const smsMessages = messages.filter((msg) => Reflect.has(msg, 'phoneNumber'));
    if (smsMessages.length !== 0) {
        const smsResult = await Promise.all(smsMessages.map((sms) => publisher.sendSms(sms)));
        logger('Result of sms dispatch', smsResult);
    }

    if (Reflect.has(resultOfSend, 'result') && resultOfSend.result === 'SUCCESS') {
        const successfulMsgs = destinationUserIds.filter((userId) => !resultOfSend.failedMessageIds.includes(userId));
        return { channel: 'EMAIL', result: 'SUCCESS', numberSent: successfulMsgs.length };
    }

    return { channel: 'EMAIL', result: 'ERR', message: JSON.stringify(resultOfSend) };
};

const generatePNsFromSpecificMsgs = async (destinationUserIds, params) => {
    const userTokenDict = await rdsMainUtil.getPushTokens(destinationUserIds, params.provider);
    logger('Sending message per token dict: ', userTokenDict);

    const messages = destinationUserIds.
        filter((userId) => Reflect.has(userTokenDict, userId)).
        map((userId) => ({
            to: userTokenDict[userId],
            title: params.title,
            body: params.body
    }));

    return chunkAndSendMessages(messages);
};

const handleSpecificMessages = async (params) => {
    // sometimes other lambdas call this with specified IDs (e.g., event-based), so need to do check
    logger('Handling once-off specific messages with params: ', params);
    const { route, systemWideUserIds } = params;
    const doNotSendUsers = await rdsMainUtil.getListOfNoPushUsers(systemWideUserIds);
    const destinationUserIds = systemWideUserIds.filter((userId) => !doNotSendUsers.includes(userId));

    if (route === 'PUSH') {
        return generatePNsFromSpecificMsgs(destinationUserIds, params);
    }
    
    if (route === 'EMAIL') {
        return sendEmailsToSpecificUsers(destinationUserIds, params); 
    }

    throw Error('No route or invalid route provided');
};

/**
 * Primary method. Sends push messages and emails in parallel. 
 * @param {object} params An optional object containing an array of system wide user ids. Used during push message dispatch.
 * @property {Array} systemWideUserIds An optional array of system wide user ids who will serve as reciepients of the push notifications.
 */
module.exports.sendOutboundMessages = async (params) => {
    try {
        let result = {};
        
        if (typeof params === 'object' && Reflect.has(params, 'systemWideUserIds')) {
            result = await handleSpecificMessages(params);
        } else {
            // do-not-send users filtered within pull of pending messages via join
            result = await Promise.all([sendPendingEmailMsgs(), sendPendingPushMsgs()]);
        }

        logger('Result of outbound messages:', result);
        return result;

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { result: 'ERR', message: err.message };
    }
};
