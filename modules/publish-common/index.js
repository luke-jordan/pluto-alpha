'use strict';

const crypto = require('crypto');

const logger = require('debug')('jupiter:logging-module:main');
const config = require('config');
const moment = require('moment');

const stringify = require('json-stable-stringify');
const format = require('string-format');

const AWS = require('aws-sdk');
const sns = new AWS.SNS({ region: config.get('aws.region') });

const ses = new AWS.SES();
const s3 = new AWS.S3();

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
        const params = {
            Message: message,
            MessageStructure: 'string',
            PhoneNumber: phoneNumber
        };
    
        const resultOfDispatch = await sns.publish(params).promise();
        logger('Result of SMS dispatch:', resultOfDispatch);
        if (typeof resultOfDispatch === 'object' && Reflect.has(resultOfDispatch, 'MessageId')) {
            return { result: 'SUCCESS' };
        }

        logger('FATAL_ERROR: ', params);
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

const assembleEmailParameters = ({ sourceEmail, toList, subject, htmlBody, textBody }) => ({
    Destination: {
        ToAddresses: toList
    },
    Message: { Body: { 
        Html: { Data: htmlBody },
        Text: { Data: textBody }
    },
    Subject: { Data: subject }},
    Source: sourceEmail,
    ReplyToAddresses: [sourceEmail],
    ReturnPath: sourceEmail
});

module.exports.sendSystemEmail = async ({ originAddress, subject, toList, bodyTemplateKey, templateVariables }) => {
    let sourceEmail = 'noreply@jupitersave.com';
    
    if (originAddress) {
        sourceEmail = originAddress;
    } else if (config.has('publishing.eventsEmailAddress')) {
        sourceEmail = config.get('publishing.eventsEmailAddress');
    }

    const template = await exports.obtainTemplate(bodyTemplateKey);
    const htmlBody = format(template, templateVariables);
    const textBody = 'Jupiter system email.'; // generic (Google shows in preview)

    const sesInvocation = assembleEmailParameters({
        sourceEmail,
        toList,
        subject,
        htmlBody,
        textBody
    });

    const emailResult = await ses.sendEmail(sesInvocation).promise();

    logger('Result of email send: ', emailResult);
    
    return { result: 'SUCCESS' };
};
