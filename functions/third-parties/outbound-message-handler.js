'use strict';

const logger = require('debug')('jupiter:third-parties:sendgrid');
const config = require('config');
const uuid = require('uuid/v4');

const format = require('string-format');

const request = require('request-promise');
const tiny = require('tiny-json-http');

const opsUtil = require('ops-util-common');
const sleep = require('util').promisify(setTimeout);

const {
    classes: {
      Mail
    }
  } = require('@sendgrid/helpers');

const AWS = require('aws-sdk');

const s3 = new AWS.S3();

const SUCCESS_STATUSES = [200, 202];

const fetchHtmlTemplate = async (Bucket, Key) => {
    const template = await s3.getObject({ Bucket, Key }).promise();
    return template.Body.toString('ascii');
};

const hasValidProperties = (object, type, requiredProperties) => {
    try {
        requiredProperties.forEach((property) => {
            if (!Reflect.has(object, property) || !object[property]) {
                logger(`Invalid ${type} object: ${JSON.stringify(object)}`);
                throw new Error(`Missing required property: ${property}`);
            }
        });
        return true;
    } catch (err) {
        logger(err.message);
        return false;
    }
};

const addMessageIdIfMissing = (emailMessage) => {
    if (!emailMessage.messageId) {
        emailMessage.messageId = uuid();
    }
    return emailMessage;
};

const validateEmailMessages = (emailMessages) => {
    const requiredProperties = ['to', 'from', 'subject', 'html'];
    return emailMessages.filter((email) => hasValidProperties(email, 'email', requiredProperties)).
        map((email) => addMessageIdIfMissing(email));
};

const chunkDispatchRecipients = (destinationArray) => {
    const chunkSize = config.get('sendgrid.chunkSize');
    /* eslint-disable id-length */
    return Array(Math.ceil(destinationArray.length / chunkSize)).fill().map((_, i) => destinationArray.slice(i * chunkSize, (i * chunkSize) + chunkSize));
};

// sendgrid support are saying we have to do this -- looking for an alternate email provider
// also, just in case, resetting the API key in here
const dispatchSingleEmail = async (msg, sandbox, retryStatus) => {
    try {
        const payload = { 
            to: msg.to, 
            from: msg.from || config.get('sendgrid.fromAddress'), 
            subject: msg.subject, 
            text: msg.text, 
            html: msg.html, 
            ...sandbox 
        }; // filters out messageId property
        
        const debugMail = Mail.create(payload);
        const mailBody = debugMail.toJSON();
        logger('API request body: ', JSON.stringify(mailBody));

        const options = {
            url: config.get('sendgrid.endpoint'),
            headers: {
                'Authorization': `Bearer ${config.get('sendgrid.apiKey')}`,
                'Content-Type': 'application/json'
            },
            data: mailBody
        };

        logger('Assembled options:', options);
        const result = await tiny.post(options);
        logger('API result: ', JSON.stringify(result));
        return { statusCode: 200 };
    } catch (error) {
        // interim, so we can see how many failures we get
        logger('FATAL_ERROR: ', error);

        if (!retryStatus) {
            // must be first retry, so set it and return
            const initialTime = config.get('retry.initialPeriod');
            await sleep(initialTime);
            const initialRetryStatus = { elapsedTime: initialTime, totalRetries: 1, lastWaitTime: initialTime };
            return dispatchSingleEmail(msg, sandbox, initialRetryStatus);
        }

        const { elapsedTime, totalRetries, lastWaitTime } = retryStatus;
        const waitTime = lastWaitTime * 2;
        const tryAgain = (elapsedTime + waitTime) < config.get('retry.maxRetryTime') && totalRetries < config.get('retry.maxRetries'); 
            
        if (tryAgain) {
            await sleep(waitTime);
            const newElapsedTime = elapsedTime + waitTime;
            const newRetries = totalRetries + 1;
            const newRetryStatus = { elapsedTime: newElapsedTime, totalRetries: newRetries, lastWaitTime: waitTime };
            return dispatchSingleEmail(msg, sandbox, newRetryStatus);
        }

        logger('FATAL_ERROR: ', error);
        return { statusCode: 400 };
    }
};

const dispatchEmailMessageChunk = async (chunk) => {
    try {
        // being very careful here
        const sandboxOff = config.has('sendgrid.sandbox.off') && typeof config.get('sendgrid.sandbox.off') === 'boolean' && config.get('sendgrid.sandbox.off');
        const sandbox = { 'mail_settings': { 'sandbox_mode': { enable: !sandboxOff } }};
        
        const mailSendPromises = chunk.map((msg) => dispatchSingleEmail(msg, sandbox));
        const mailSendResults = await Promise.all(mailSendPromises);

        const messageIdResults = chunk.map((msg, index) => ({ messageId: msg.messageId, statusCode: mailSendResults[index].statusCode }));        
        return { result: 'SUCCESS', messageIdResults };
    } catch (error) {
        logger('FATAL_ERROR: ', error);
        const messageIds = chunk.map((msg) => msg.messageId);
        return { result: 'ERROR', messageIds };
    }
};

const wrapHtmlinTemplate = (emailMessages, wrapperTemplate) => emailMessages.map((msg) => (
    { ...msg, html: format(wrapperTemplate, { htmlBody: msg.html })
}));

/**
 * This function sends pre-assembled emails, with the option of enclosing them in a wrapper from S3.
 * @param    {object} event
 * @property {array}  emailMessages An array of emails objects to be dispatched. 
 * Each email must have the following properties: messageId, to, from, subject, text, html.
 */
module.exports.sendEmailMessages = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            return { result: 'Empty invocation' };
        }

        const { emailMessages } = opsUtil.extractParamsFromEvent(event);
        let validMessages = validateEmailMessages(emailMessages);

        if (!validMessages || validMessages.length === 0) {
            throw new Error('No valid emails found');
        }

        if (event.emailWrapper) {
            const { s3bucket, s3key } = event.emailWrapper;
            const wrapperTemplate = await fetchHtmlTemplate(s3bucket, s3key);
            validMessages = wrapHtmlinTemplate(validMessages, wrapperTemplate); 
        }

        logger('Validated messages: ', validMessages);
        const validMessageIds = validMessages.map((msg) => msg.messageId);
        const messageChunks = chunkDispatchRecipients(validMessages);
        
        logger('Created chunks of length:', messageChunks.map((chunk) => chunk.length));
        const dispatchResult = await Promise.all(messageChunks.map((chunk) => dispatchEmailMessageChunk(chunk)));

        const failedChunks = dispatchResult.map((chunk) => {
            const { result } = chunk;
            if (result === 'ERROR' || !chunk.messageIdResults) {
                return chunk.messageIds; // all of them
            }
            return chunk.messageIdResults.
                filter((messageResult) => !SUCCESS_STATUSES.includes(messageResult.statusCode)).map((messageResult) => messageResult.messageId);
        }).reduce((flatArray, currentArray) => [...flatArray, ...currentArray], []);

        const failedMessages = emailMessages.filter((message) => !validMessageIds.includes(message.messageId) || failedChunks.includes(message.messageId));
        logger('Failed messages:', failedMessages.length);

        const failedMessageIds = failedMessages.map((msg) => msg.messageId);
        if (failedMessageIds.length === emailMessages.length) {
            throw Error('Dispatch error');
        }
        
        const result = failedMessageIds.length === 0 ? 'SUCCESS' : 'PARTIAL';

        return { result, failedMessageIds };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERR', message: err.message };
    }
};

/**
 * This function sends sms messages via the Twilio api. It accepts a message and a phone number, assembles the request,
 * then hits up the Twilio API.
 */
module.exports.sendSmsMessage = async (event) => {
    try {
        if (!config.has('twilio.mock') && config.get('twilio.mock') !== 'OFF') {
            return { result: 'SUCCESS' };
        }

        const { message, phoneNumber } = opsUtil.extractParamsFromEvent(event);

        const options = {
            method: 'POST',
            uri: format(config.get('twilio.endpoint'), config.get('twilio.accountSid')),
            form: {
                Body: message,
                From: config.get('twilio.number'),
                To: `+${phoneNumber}` 
            },
            auth: {
                username: config.get('twilio.accountSid'),
                password: config.get('twilio.authToken')
            },
            json: true
        };

        logger('Assembled options:', options);
        const result = await request(options);
        logger('Got result:', result);

        if (result['error_code'] || result['error_message']) {
            return { result: 'FAILURE', message: result['error_message'] };
        }

        return { result: 'SUCCESS' };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { statusCode: 500 };
    }
};

module.exports.handleOutboundMessages = async (event) => {
    const params = opsUtil.extractParamsFromEvent(event);
    logger('Sending outbound message, with event: ', event);

    if (Array.isArray(params.emailMessages) && params.emailMessages.length > 0) {
        return exports.sendEmailMessages(event);
    }

    if (params.phoneNumber) {
        return exports.sendSmsMessage(event);
    }

    // logger('FATAL_ERROR: Unrecognized event:', event);
    return { result: 'FAILURE' };
};
