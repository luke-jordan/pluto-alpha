'use strict';

const logger = require('debug')('jupiter:logging-module:main');
const config = require('config');
const moment = require('moment');

const stringify = require('json-stable-stringify');
const format = require('string-format');

const AWS = require('aws-sdk');
const sns = new AWS.SNS({ region: config.get('aws.region') });

const ses = new AWS.SES();
const s3 = new AWS.S3();

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
            context: options.context
        };

        const messageForQueue = {
            Message: stringify(eventToPublish),
            Subject: eventType,
            TopicArn: config.get('publishing.userEvents.topicArn')
        };

        logger('Sending to queue: ', messageForQueue);

        const resultOfPublish = await sns.publish(messageForQueue).promise();
        logger('Result from queue: ', resultOfPublish);

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
