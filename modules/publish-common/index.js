'use strict';

const crypto = require('crypto');

const logger = require('debug')('jupiter:logging-module:main');
const config = require('config');
const moment = require('moment');

const htmlToText = require('html-to-text');
const format = require('string-format');

const uuid = require('uuid/v4');
const stringify = require('json-stable-stringify');

const AWS = require('aws-sdk');
const sns = new AWS.SNS({ region: config.get('aws.region') });

const s3 = new AWS.S3();
const lambda = new AWS.Lambda();

// config's biggest weakness is its handling of modules, which blows. there is a complex way
// to set defaults but it requires a constructor pattern, so far as I can tell. hence, doing this. 
const getCryptoConfigOrDefault = (key, defaultValue) => (config.has(`publishing.hash.${key}`) 
    ? config.get(`publishing.hash.${key}`) : defaultValue);

const generateHashForEvent = (eventType) => {
    const hashingSecret = getCryptoConfigOrDefault('key', 'abcdefg');
    const generatedHash = crypto.createHmac(getCryptoConfigOrDefault('algo', 'sha256'), hashingSecret).
        update(`${hashingSecret}_${eventType}`).
        digest(getCryptoConfigOrDefault('digest', 'hex'));
    return generatedHash;
};

const wrapLambdaInvocation = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: stringify(payload)
});

module.exports.publishUserEvent = async (userId, eventType, options = {}) => {
    try {
        logger('Publishing user event to topic');
        const eventTime = options.timestamp || moment().valueOf();
        const eventToPublish = {
            userId,
            eventType,
            timestamp: eventTime,
            interface: options.interface,
            initiator: options.initiator,
            context: options.context,
            hash: generateHashForEvent(eventType)
        };

        const messageForQueue = {
            Message: stringify(eventToPublish),
            Subject: eventType,
            TopicArn: config.get('publishing.userEvents.topicArn')
        };

        // logger('Sending to queue: ', messageForQueue);

        logger(`Logging ${eventType} for user ID ${userId}`);
        const resultOfPublish = await sns.publish(messageForQueue).promise();
        // logger('Result from queue: ', resultOfPublish);

        if (typeof resultOfPublish === 'object' && Reflect.has(resultOfPublish, 'MessageId')) {
            return { result: 'SUCCESS' };
        }

        logger('PUBLISHING_ERROR: Published message: ', messageForQueue);
        return { result: 'FAILURE' };
    } catch (err) {
        logger('PUBLISHING_ERROR: ', err);
        return { result: 'FAILURE' };
    }
};

module.exports.publishMultiUserEvent = async (userIds, eventType, options = {}) => {
    try {
        // note: SNS does not have a batch publish method, so we do this -- do not ever call this in user facing method
        const publishPromises = userIds.map((userId) => exports.publishUserEvent(userId, eventType, options));
        logger('Sending ', publishPromises.length, ' events to the user log topic');
        const resultOfAll = await Promise.all(publishPromises);
        const successCount = resultOfAll.filter((returned) => returned.result === 'SUCCESS').length;
        logger(`Of promises, ${successCount} were successful`);
        return { successCount, failureCount: userIds.length - successCount };
    } catch (err) {
        // means was not caught in interior (i.e., above)
        logger('PUBLISHING_ERROR: Bulk error: ', err);
        return { result: 'FAILURE' };
    }
};

module.exports.sendSms = async ({ phoneNumber, message }) => {
    try {    
        const smsInvocation = wrapLambdaInvocation(config.get('lambdas.sendOutboundMessages'), { phoneNumber, message }, false);
        const resultOfSms = await lambda.invoke(smsInvocation).promise();
        logger('Result of transfer: ', resultOfSms);

        const smsResultPayload = JSON.parse(resultOfSms['Payload']);
        if (smsResultPayload['statusCode'] === 200) {
            const smsResultBody = JSON.parse(smsResultPayload.body);
            logger('Got sms result body:', smsResultBody);
            return { result: 'SUCCESS' };
        }

        return { result: 'FAILURE' };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE' };
    }
};

module.exports.obtainTemplate = async (templateName) => {
    const templateBucket = config.has('templates.bucket') ? config.get('templates.bucket') : 'staging.jupiter.templates';

    logger(`Getting template from bucket ${templateBucket} and key, ${templateName}`);
    const s3result = await s3.getObject({ Bucket: templateBucket, Key: templateName }).promise();
    const templateText = s3result.Body.toString('utf-8');
    
    return templateText;
};

module.exports.safeEmailSendPlain = async (emailMessage, sync = false) => {
    try {
        const emailInvocation = wrapLambdaInvocation(config.get('lambdas.sendOutboundMessages'), { emailMessages: [emailMessage] }, sync);
        const emailResult = await lambda.invoke(emailInvocation).promise();
        logger('Sent email: ', emailResult);
        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { result: 'FAILURE' };
    }
};

module.exports.sendSystemEmail = async ({ originAddress, subject, toList, bodyTemplateKey, templateVariables }) => {
    let sourceEmail = 'noreply@jupitersave.com';
    
    if (originAddress) {
        sourceEmail = originAddress;
    } else if (config.has('publishing.eventsEmailAddress')) {
        sourceEmail = config.get('publishing.eventsEmailAddress');
    }

    const template = await exports.obtainTemplate(bodyTemplateKey);
    const html = format(template, templateVariables);
    const text = htmlToText.fromString(html, { wordwrap: false });

    // message id property allows lambda to return failed message ids
    const emailMessages = toList.map((recipient) => ({
        messageId: uuid(),
        to: recipient,
        from: sourceEmail,
        subject,
        html,
        text
    }));

    logger('Asembled emails:', emailMessages);
    const emailInvocation = wrapLambdaInvocation(config.get('lambdas.sendOutboundMessages'), { emailMessages }, false);
    const resultOfEmail = await lambda.invoke(emailInvocation).promise();
    logger('Result of transfer: ', resultOfEmail);

    const dispatchPayload = JSON.parse(resultOfEmail['Payload']);
    if (dispatchPayload['statusCode'] === 200) {
        const dispatchBody = JSON.parse(dispatchPayload.body);
        logger('Got email result body:', dispatchBody);
        
        return { result: 'SUCCESS' };
    }
    
    return { result: 'FAILURE' };
};
