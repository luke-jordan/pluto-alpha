'use strict';

const logger = require('debug')('jupiter:admin:logging');
const config = require('config');
const moment = require('moment');

const adminUtil = require('./admin.util');
const publisher = require('publish-common');
const opsCommonUtil = require('ops-util-common');

const AWS = require('aws-sdk');

AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();
const s3 = new AWS.S3();

const publishUserLog = async ({ adminUserId, systemWideUserId, eventType, context }) => {
    const logOptions = { initiator: adminUserId, context };
    logger('Dispatching user log of event type: ', eventType, ', with log options: ', logOptions);
    return publisher.publishUserEvent(systemWideUserId, eventType, logOptions);
};

const uploadBinaryFile = async (systemWideUerId, data) => {
    const { fileName, fileContent } = data;
    const fileKey = `${systemWideUerId}/${fileName}`;
    const params = {
        Bucket: config.get('s3.binaries.bucket'),
        Key: fileKey,
        Body: Buffer.from(fileContent, 'base64')
    };
    logger('Uploading binary with params:', params);
    const result = await s3.upload(params).promise();
    logger('Result of upload:', result);
    // todo: result validation
    return fileKey;
};

/**
 * This function write a user log. If a binary file is included the file is uploaded to s3 and the path to
 * the file is stored in the user logs event context.
 * @param {object} event An admin event.
 * @property {string} systemWideUerId The user id whom the log pertains to.
 * @property {string} eventType The type of event to be logged.
 * @property {string} note An optional note describing details relevant to the log.
 * @property {string} binaryFile An optional object containing a binary file and the files name, e.g. { fileName, fileContent }
 */
module.exports.writeLog = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    try {
        const adminUserId = event.requestContext.authorizer.systemWideUserId;
        const params = adminUtil.extractEventBody(event);
        const { systemWideUserId, eventType, note, binaryFile } = params;

        const context = { systemWideUserId, note };

        if (binaryFile) {
            const uploadResult = await uploadBinaryFile(systemWideUserId, binaryFile);
            context.binaryS3Key = uploadResult;
        }

        const publishResult = await publishUserLog({ adminUserId, systemWideUserId, eventType, context });
        logger('Result of publish:', publishResult);

        return adminUtil.wrapHttpResponse({ publishResult });
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};

const appendEventBinary = async (event) => {
    const context = JSON.parse(event.context);
    if (context.binaryS3Key) {
        const params = { Bucket: config.get('s3.binaries.bucket'), Key: context.binaryS3Key };
        const binaryFile = await s3.getObject(params).promise();
        // todo: map file type in key to relevent decoder
        event.binaryFile = binaryFile.Body.toString('base64');
    }
    return event;
};

const fetchUserEventLog = async (systemWideUserId, eventType, startDate) => {
    const userEventParams = {
        userId: systemWideUserId,
        eventTypes: [eventType],
        startDate,
        endDate: moment().valueOf()
    };

    const userLogInvocation = adminUtil.invokeLambda(config.get('lambdas.userHistory'), userEventParams);
    const userLogResult = await lambda.invoke(userLogInvocation).promise();
    logger('Result of log fetch: ', userLogResult);

    if (userLogResult['StatusCode'] !== 200 || JSON.parse(userLogResult['Payload']).result !== 'SUCCESS') {
        logger('ERROR! Something went wrong fetching user log');
    }

    return JSON.parse(userLogResult['Payload']).userEvents;
};

/**
 * This file fetches a user log. If the s3 file path of a binary file is found the file is retrieved and
 * return with the function ooutput.
 * @param {object} event An admin event.
 * @property {string} systemWideUerId The user whose logs we seek.
 * @property {string} eventType The log event type to be retrieved.
 * @property {string} timestamp The target event timestamp.
 */
module.exports.fetchLog = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    try {
        const params = opsCommonUtil.extractQueryParams(event);
        const { systemWideUserId, eventType, timestamp } = params;
        const userEventLog = await fetchUserEventLog(systemWideUserId, eventType, timestamp);
        logger('Got user user log event:', userEventLog);
    
        const userEvents = userEventLog.userEvents;
        const logsWithBinaryFiles = await Promise.all(userEvents.map((userEvent) => appendEventBinary(userEvent)));
        logger('Log with binaries:', logsWithBinaryFiles);
    
        return adminUtil.wrapHttpResponse(logsWithBinaryFiles);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};
