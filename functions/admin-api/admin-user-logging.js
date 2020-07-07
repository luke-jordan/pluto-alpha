'use strict';

const logger = require('debug')('jupiter:admin:logging');
const config = require('config');

const publisher = require('publish-common');

const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');

const AWS = require('aws-sdk');

AWS.config.update({ region: config.get('aws.region') });
const s3 = new AWS.S3();

const obtainFileForUser = async (systemWideUserId, filename) => {
    const params = {
        Bucket: config.get('binaries.s3.bucket'),
        Key: `${systemWideUserId}/${filename}`
    };
    const rawFile = await s3.getObject(params).promise();
    return rawFile.Body.toString('base64');
}

/**
 * This file fetches a user log. If the s3 file path of a binary file is found the file is retrieved and
 * return with the function ooutput.
 * @param {object} event An admin event.
 * @property {string} systemWideUserId The user whose file we are seeking.
 * @property {string} filename The filename to be retrieved.
 */
module.exports.fetchFileForUser = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    try {
        const params = opsCommonUtil.extractQueryParams(event);
        const { systemWideUserId, filename } = params;
        logger('Obtaining file: ', filename, ' for user: ', systemWideUserId);

        const fileInBase64 = await obtainFileForUser(systemWideUserId, filename);
    
        return adminUtil.wrapHttpResponse({ fileContent: fileInBase64 });
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
 * Uploads a log associated attachment. Returns the uploaded attachment's s3 key. Event body should contain:
 * @param {string} systemWideUserId The system id of the user associated with the file attachment.
 * @param {string} logDescription What caption or other description to give this document
 * @param {object} file An object containing attachment information. Properties required are: 
 * @property {string} fileContent  Base64 encoded string of the file
 * @property {string} filename The name of the file
 * @property {string} mimeType The type of the file being stored
 */
module.exports.storeDocumentForUser = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }
       
    try {
        logger('Received event as: ', JSON.stringify(event, null, 2));

        const params = adminUtil.extractEventBody(event);
        logger('Received parameters: ', params);

        const { systemWideUserId, logDescription, file } = params;
        const { filename, fileContent, mimeType } = file;
        
        const response = await uploadToS3({ userId: systemWideUserId, filename, mimeType, fileContent });
        logger('Result of upload:', response);

        const logOptions = {
            initiator: opsCommonUtil.extractUserDetails(event).systemWideUserId,
            context: {
                filename,
                mimeType,
                logDescription
            }
        };

        await publisher.publishUserEvent(systemWideUserId, 'ADMIN_STORED_DOCUMENT', logOptions);

        return adminUtil.wrapHttpResponse(response);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return adminUtil.wrapHttpResponse(err.message, 500);
    }
};

// we may want to restore these in the future, so for now am just commenting out

// const appendEventBinary = async (event) => {
//     const context = JSON.parse(event.context);
//     if (context.file) {
//         const { filePath } = context.file;
//         const params = { Bucket: config.get('binaries.s3.bucket'), Key: filePath };
//         const fileContent = await s3.getObject(params).promise();
//         event.file = fileContent.Body.toString('base64');
//     }
//     return event;
// };

// const fetchUserEventLog = async (systemWideUserId, eventType, startDate) => {
//     const userEventParams = {
//         userId: systemWideUserId,
//         eventTypes: [eventType],
//         startDate,
//         endDate: startDate + 1 // actually change log reader for this
//     };

//     const userLogInvocation = adminUtil.invokeLambda(config.get('lambdas.userHistory'), userEventParams);
//     const userLogResult = await lambda.invoke(userLogInvocation).promise();
//     logger('Result of log fetch: ', userLogResult);

//     if (userLogResult['StatusCode'] !== 200 || JSON.parse(userLogResult['Payload']).result !== 'SUCCESS') {
//         logger('ERROR! Something went wrong fetching user log');
//     }

//     return JSON.parse(userLogResult['Payload']).userEvents;
// };
