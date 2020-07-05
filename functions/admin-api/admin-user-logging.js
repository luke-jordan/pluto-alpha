'use strict';

const logger = require('debug')('jupiter:admin:logging');
const config = require('config');

const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');

const AWS = require('aws-sdk');

AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();
const s3 = new AWS.S3();

const appendEventBinary = async (event) => {
    const context = JSON.parse(event.context);
    if (context.file) {
        const { filePath } = context.file;
        const params = { Bucket: config.get('binaries.s3.bucket'), Key: filePath };
        const fileContent = await s3.getObject(params).promise();
        event.file = fileContent.Body.toString('base64');
    }
    return event;
};

const fetchUserEventLog = async (systemWideUserId, eventType, startDate) => {
    const userEventParams = {
        userId: systemWideUserId,
        eventTypes: [eventType],
        startDate,
        endDate: startDate + 1 // actually change log reader for this
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
 * @property {string} systemWideUserId The user whose logs we seek.
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
        const logsWithFileAttachments = await Promise.all(userEvents.map((userEvent) => appendEventBinary(userEvent)));
        logger('Log with binaries:', logsWithFileAttachments);
    
        return adminUtil.wrapHttpResponse(logsWithFileAttachments);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};

const uploadToS3 = async ({ userId, filename, mimeType, fileContent}) => {
    const params = {
        Bucket: config.get('binaries.s3.bucket'),
        Key: `${userId}/${filename}`,
        ContentType: mimeType,
        Body: Buffer.from(fileContent, 'base64')
    };

    const result = await s3.putObject(params).promise();
    logger('Result of binary upload to s3:', result);
    return { result: 'UPLOADED', filePath: `${userId}/${filename}` };
};

/**
 * Uploads a log associated attachment. Returns the uploaded attachment's s3 key.
 * @param {object} event An admin event.
 * @property {string} systemWideUserId The system id of the user associated with the file attachment. 
 * @property {object} file An object containing attachment information. The properties required by this function are { fileame, fileContent, mimeType }.
 */
module.exports.uploadLogBinary = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }
       
    try {
        logger('Received event as: ', JSON.stringify(event));
        const params = adminUtil.extractEventBody(event);
        logger('Received log binary: ', params);

        const { systemWideUserId, file } = params;
        const { filename, fileContent, mimeType } = file;
        
        const response = await uploadToS3({ userId: systemWideUserId, filename, mimeType, fileContent });
        logger('Result of upload:', response);

        return adminUtil.wrapHttpResponse(response);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};

/**
 * This is the binary upload functions integration function. Called by API gateway, it accepts requests
 * from uploadLogBinary, decodes the base 64 encoded file content and persists the file to an s3
 * bucket.
 * @param {object} event 
 * @property {string} userId The user associated with the file to be stored.
 * @property {string} filename The name of the file.
 * @property {string} content The base 64 encoded file.
 */
module.exports.storeBinary = async (event) => {
    try {
        logger('Event looks like: ', event);
        const fileContent = event.content;
        const { userId, filename, mimeType } = opsCommonUtil.extractParamsFromEvent(event);

        await uploadToS3({ userId, filename, mimeType, fileContent });

        return adminUtil.wrapHttpResponse({ filePath: `${userId}/${filename}` });
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};
