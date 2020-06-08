'use strict';

const logger = require('debug')('jupiter:admin:logging');
const config = require('config');
const moment = require('moment');
const request = require('request-promise');

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

/**
 * This function write a user log. If a binary file is included the file is uploaded to s3 and the path to
 * the file is stored in the user logs event context.
 * @param {object} event An admin event.
 * @property {string} systemWideUserId The user id whom the log pertains to.
 * @property {string} eventType The type of event to be logged.
 * @property {string} note An optional note describing details relevant to the log.
 * @property {string} file An optional object containing the file path to an attachment file to be associated with the log being written.
 */
module.exports.writeLog = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    try {
        const adminUserId = event.requestContext.authorizer.systemWideUserId;
        const params = adminUtil.extractEventBody(event);
        const { systemWideUserId, eventType, note, file } = params;

        const context = { systemWideUserId, note, file };
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
        const params = adminUtil.extractEventBody(event);
        const { systemWideUserId, file } = params;
        const { filename, fileContent, mimeType } = file;
        
        const options = {
            method: 'POST',
            uri: config.get('binaries.endpoint'),
            formData: {
                userId: systemWideUserId,
                file: {
                    value: fileContent, // file stream object
                    options: { filename, mimeType }
                }
            }
        };

        logger('Uploading binary with params:', options);
        const response = await request(options);
        logger('Result of upload:', response);

        if (!response || typeof response !== 'object' || response.statusCode !== 200) {
            throw new Error('Error uploading binary');
        }

        const { filePath } = JSON.parse(response.body);
        return adminUtil.wrapHttpResponse({ filePath });
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
        const fileContent = event.content;
        const { userId, filename, mimeType } = opsCommonUtil.extractParamsFromEvent(event);

        const params = {
            Bucket: config.get('binaries.s3.bucket'),
            Key: `${userId}/${filename}`,
            ContentType: mimeType,
            Body: Buffer.from(fileContent, 'base64')
        };

        const result = await s3.putObject(params).promise();
        logger('Result of binary upload to s3:', result);

        return adminUtil.wrapHttpResponse({ filePath: `${userId}/${filename}` });
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};