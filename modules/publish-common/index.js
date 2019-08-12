'use strict';

const logger = require('debug')('jupiter:logging-module:main');
const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const AWS = require('aws-sdk');
const sns = new AWS.SNS({ region: config.get('aws.region') });

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
            TopicArn: config.get('publishing.userEvents.topicArn'),
            Subject: eventType,
            Message: stringify(eventToPublish)
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
