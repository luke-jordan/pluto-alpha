'use strict';

const logger = require('debug')('jupiter:third-parties:sendgrid');
const config = require('config');
const opsUtil = require('ops-util-common');

const path = require('path');
const htmlToText = require('html-to-text');
const sendGridMail = require('@sendgrid/mail');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

sendGridMail.setApiKey(config.get('sendgrid.apiKey'));
sendGridMail.setSubstitutionWrappers('{{', '}}');

const SUCCESS_STATUSES = [200, 202];

const fetchHtmlTemplate = async (Bucket, Key) => {
    const template = await s3.getObject({ Bucket, Key }).promise();
    return template.Body.toString('ascii');
};

const fetchAttachment = async (filename, Bucket, Key) => {
    const attachment = await s3.getObject({ Bucket, Key }).promise();
    if (path.extname(filename) === '.pdf') {
        return attachment.Body.toString('base64');
    }

    return attachment.Body.toString('ascii');
};

const validateDispatchEvent = ({ subject, templateKeyBucket, htmlTemplate, destinationArray, attachments }) => {
    if (!templateKeyBucket && !htmlTemplate) {
        throw new Error('Missing required html template');
    }
     
    if (templateKeyBucket) {
        if (!Reflect.has(templateKeyBucket, 'bucket') || !Reflect.has(templateKeyBucket, 'key')) {
            throw new Error('Missing valid template key-bucket pair');
        }
    }

    if (!Array.isArray(destinationArray) || destinationArray.length === 0) {
        throw new Error('Missing destination array');
    }

    if (!subject) {
        throw new Error('Missing email subject');
    }

    if (attachments) {
        attachments.forEach((attachment) => {
            if (!Reflect.has(attachment, 'filename') || !attachment.filename) {
                throw new Error('Invalid attachment. Missing attachment filename');
            }

            if (!Reflect.has(attachment, 'source') || !Reflect.has(attachment.source, 'bucket') || !Reflect.has(attachment.source, 'key')) {
                throw new Error('Invalid attachment source');
            }
            
            if (!Object.keys(config.get('sendgrid.supportedAttachments')).includes(path.extname(attachment.filename))) {
                throw new Error(`Unsupported attachment type: ${attachment.filename}`);
            }
        });
    }

    const invalidDestinations = [];
    destinationArray.forEach((destination) => {
        if (typeof destination !== 'object' || Object.keys(destination).length === 0) {
            logger(`Invalid email destination object: ${JSON.stringify(destination)}`);
            invalidDestinations.push(destination);
        }

        if (!destination.emailAddress || !destination.templateVariables) {
            logger(`Invalid email destination object: ${JSON.stringify(destination)}`);
            invalidDestinations.push(destination);
        }
    });

    return invalidDestinations;
};

const validateDispatchParams = (dispatchParams) => {
    if (!dispatchParams.htmlTemplate && !dispatchParams.textTemplate) {
        throw new Error('You must provide either a text or html template or both'); // unreachable but a good fortification
    }

    if (dispatchParams.htmlTemplate && typeof dispatchParams.htmlTemplate !== 'string') {
        throw new Error(`Invalid HTML template: ${JSON.stringify(dispatchParams.htmlTemplate)}`);
    }

    if (dispatchParams.textTemplate && typeof dispatchParams.textTemplate !== 'string') {
        throw new Error(`Invalid text template: ${JSON.stringify(dispatchParams.textTemplate)}`);
    }
};

const validateDispatchPayload = (payload) => {
    const standardProperties = ['from', 'reply_to', 'subject', 'content', 'mail_settings', 'personalizations'];

    standardProperties.forEach((property) => {
        if (!standardProperties.includes(property)) {
            throw new Error(`Malformed email dispatch payload. Missing required property: ${property}`);
        }

        if (Array.isArray(payload[property])) {
            if (payload[property].length === 0) {
                throw new Error(`No values found for property: ${property}`);
            }
        }
    });

    if (!payload.from.email) {
        throw new Error('Configuration error. Missing payload source email address');
    }
};

const countSubstitutions = (template) => template.match(/\{\{/gu).length;

const validateSubstitutions = (template, destinations) => {
    const substitutionCount = countSubstitutions(template);
    logger('Got substitution count:', substitutionCount);
    return destinations.filter((destination) => Object.keys(destination.templateVariables).length < substitutionCount);
};

// todo: refactor
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

const validateEmailMessages = (emailMessages) => {
    const requiredProperties = ['messageId', 'to', 'from', 'subject', 'text', 'html'];
    return emailMessages.filter((email) => hasValidProperties(email, 'email', requiredProperties));
};

const chunkDispatchRecipients = (destinationArray) => {
    const chunkSize = config.get('sendgrid.chunkSize');
    /* eslint-disable id-length */
    return Array(Math.ceil(destinationArray.length / chunkSize)).fill().map((_, i) => destinationArray.slice(i * chunkSize, (i * chunkSize) + chunkSize));
};

const assembleDispatchPayload = (dispatchParams, destinationArray) => {
    const fromName = dispatchParams.sourceDetails ? dispatchParams.sourceDetails.fromName : config.get('sendgrid.fromName');
    const replyToName = dispatchParams.sourceDetails ? dispatchParams.sourceDetails.replyToName : config.get('sendgrid.replyToName');

    const { subject, htmlTemplate, textTemplate, attachments } = dispatchParams;
    
    const invalidDestinations = countSubstitutions(htmlTemplate) > 0 ? validateSubstitutions(htmlTemplate, destinationArray) : [];

    const payload = {
        'from': {
            'email': config.get('sendgrid.fromAddress'),
            'name': fromName
        },
        'reply_to': {
            'email': config.get('sendgrid.replyToAddress'),
            'name': replyToName
        },
        'subject': '{{subject}}',
        'content': [],
        'mail_settings': {
            'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
        }
    };

    const personalizationsArray = [];
    destinationArray.forEach((destination) => {
        if (!invalidDestinations.includes(destination)) {
            const substitutions = destination.templateVariables;
            substitutions.subject = subject;
            personalizationsArray.push({
                to: [{ email: destination.emailAddress }],
                substitutions
            });
        }
    });

    payload.personalizations = personalizationsArray;

    if (textTemplate) {
        payload.content.push({ 'type': 'text/plain', 'value': textTemplate });
    }

    if (htmlTemplate) {
        payload.content.push({ 'type': 'text/html', 'value': htmlTemplate });
    }

    if (attachments) {
        payload.attachments = attachments;
    }

    return { payload, invalidDestinations };
};

const fetchAttachmentType = (fileExtension) => config.get('sendgrid.supportedAttachments')[fileExtension];

const assembleAttachments = async (attachments) => {
    const formattedAttachments = [];
    for (const attachment of attachments) {
        const attachmentType = fetchAttachmentType(path.extname(attachment.filename));
        const { key, bucket } = attachment.source;
        /* eslint-disable no-await-in-loop */
        const file = await fetchAttachment(attachment.filename, bucket, key);
        /* eslint-enable no-await-in-loop */
        formattedAttachments.push({
            content: file,
            filename: attachment.filename,
            type: attachmentType,
            disposition: 'attachment'
        });
    }

    return formattedAttachments;
};

const assembleDispatchParams = async ({ subject, templateKeyBucket, htmlTemplate, textTemplate, attachments, sourceDetails }) => {
    const dispatchParams = { subject };

    if (templateKeyBucket) {
        const { bucket, key } = templateKeyBucket;
        dispatchParams.htmlTemplate = await fetchHtmlTemplate(bucket, key);
    }

    if (htmlTemplate) {
        dispatchParams.htmlTemplate = htmlTemplate;
    }

    if (textTemplate) {
        dispatchParams.textTemplate = textTemplate;
    } else {
        dispatchParams.textTemplate = htmlToText.fromString(dispatchParams.htmlTemplate, { wordwrap: false });
    }

    if (attachments && attachments.length > 0) {
        dispatchParams.attachments = await assembleAttachments(attachments);
    }

    if (sourceDetails) {
        dispatchParams.sourceDetails = sourceDetails;
    }

    return dispatchParams;
};

const formatResult = (result) => ({ statusCode: result[0].statusCode, statusMessage: result[0].statusMessage });

const dispatchEmailChunk = async (chunk, params) => {
    const { payload, invalidDestinations } = assembleDispatchPayload(params, chunk);
    validateDispatchPayload(payload);
    const resultOfDispatch = await sendGridMail.send(payload);
    return { result: formatResult(resultOfDispatch), invalidDestinations };
};

/**
 * This function sends emails to provided addresses. The email template is stored remotely and a locator key-bucket pair is required. In order to use substitutions in the email template
 * simply enclose the name of the template variable in double braces, then add the variable name and value to the destination objects temblateVariable object within the destinationArray.
 * For example, if your template was 'Greetings {{user}}.' then in order to insert a different username per address, the destination object related to this template would look
 * like { emailAddress: user@email, templateVariables: { user: 'Vladimir' } }. The user will then recieve an email: 'Greetings Vladimir'. Multiple substitutions are supported.
 * This format also applies the below sendEmails function.
 * @param    {object}  event 
 * @property {object}  templateKeyBucket An object whose properties are the s3 key and bucket containing the emails html template.
 * @property {string}  textTemplate The emails text template. String formatting requires the name of the varriable enclosed in double braces i.e {{variableName}}. This also applies to the html template on S3.
 * @property {subject} subject The emails subject. Required.
 * @property {array}   destinationArray An array containing destination objects. Each destination object is of the form { emailAddress: 'user@email.com, templateVariables: { username: 'Jane', etc...} }.
 * @property {array}   attachments An array containing objects of the form { source: { key, bucket }, filename: 'file.pdf' }, describing the attachment's name and location in s3.
 */
module.exports.sendEmailsFromSource = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            return { result: 'Empty invocation' };
        }

        const { subject, templates, destinationArray, attachments, sourceDetails } = opsUtil.extractParamsFromEvent(event);
        const { templateKeyBucket, textTemplate } = templates;

        const invalidDestinationArray = validateDispatchEvent({ subject, templateKeyBucket, destinationArray, attachments });
        const sanitizedDestinationArray = destinationArray.filter((destination) => !invalidDestinationArray.includes(destination));
        if (sanitizedDestinationArray.length === 0) {
            throw new Error('No valid destinations found');
        }

        const dispatchParams = await assembleDispatchParams({ subject, templateKeyBucket, textTemplate, attachments, sourceDetails });
        
        validateDispatchParams(dispatchParams);

        const dispatchChunks = chunkDispatchRecipients(sanitizedDestinationArray);
        /* eslint-enable id-length */

        const dispatchResult = await Promise.all(dispatchChunks.map((chunk) => dispatchEmailChunk(chunk, dispatchParams)));
        logger('Dispatch result:', JSON.stringify(dispatchResult));
        
        const failedAddresses = [
            ...invalidDestinationArray,
            ...dispatchResult.reduce((failedArray, result) => [...failedArray, ...result.invalidDestinations], [])
        ];
        // todo: Add addresses in failed chunks to failedAdresses, DLQ then SES failed addresses

        return { result: 'SUCCESS', failedAddresses };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERR', message: err.message };
    }
};

/**
 * This function sends emails to provided addresses.
 * @param    {object}  event 
 * @property {object}  htmlTemplate The emails html template.
 * @property {string}  textTemplate The emails text template. String formatting requires the name of the varriable enclosed in double braces i.e {{variableName}}. This also applies to the html template on S3.
 * @property {subject} subject Required property. The emails subject.
 * @property {array}   destinationArray An array containing destination objects. Each destination object is of the form { emailAddress: 'user@email.com, templateVariables: { username: 'John', etc...} }.
 * @property {array}   attachments An array containing objects of the form { source: { key, bucket }, filename: 'file.pdf' }, describing the attachment's name and location in s3.
 */
module.exports.sendEmails = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            return { result: 'Empty invocation' };
        }
        const { subject, templates, destinationArray, attachments, sourceDetails } = opsUtil.extractParamsFromEvent(event);
        const { htmlTemplate, textTemplate } = templates;

        const invalidDestinationArray = validateDispatchEvent({ subject, htmlTemplate, destinationArray, attachments });
        const sanitizedDestinationArray = destinationArray.filter((destination) => !invalidDestinationArray.includes(destination));
        if (sanitizedDestinationArray.length === 0) {
            throw new Error('No valid destinations found');
        }

        const dispatchParams = await assembleDispatchParams({ subject, htmlTemplate, textTemplate, attachments, sourceDetails });
        
        validateDispatchParams(dispatchParams);

        const dispatchChunks = chunkDispatchRecipients(sanitizedDestinationArray);
        /* eslint-enable id-length */

        const dispatchResult = await Promise.all(dispatchChunks.map((chunk) => dispatchEmailChunk(chunk, dispatchParams)));
        logger('Dispatch result:', JSON.stringify(dispatchResult));
        
        const failedAddresses = [
            ...invalidDestinationArray,
            ...dispatchResult.reduce((failedArray, result) => [...failedArray, ...result.invalidDestinations], [])
        ];


        return { result: 'SUCCESS', failedAddresses };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERR', message: err.message };
    }
};

const dispatchEmailMessageChunk = async (chunk) => {
    const payload = chunk.reduce((array, msg) => ([...array, { to: msg.to, from: msg.from, subject: msg.subject, text: msg.text, html: msg.html }]), []); // filters out messageId property
    const result = await sendGridMail.send(payload);
    return { result: JSON.stringify(result), messageIds: chunk.map((msg) => msg.messageId) };
};

/**
 * This function sends pre-assembled emails.
 * @param    {object} event
 * @property {array}  emailMessages An array of emails objects to be dispatched. Each email must have the following properties: messageId, to, from, subject, text, html.
 */
module.exports.sendEmailMessages = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            return { result: 'Empty invocation' };
        }

        const { emailMessages } = opsUtil.extractParamsFromEvent(event);
        const validMessages = validateEmailMessages(emailMessages);

        if (!validMessages || validMessages.length === 0) {
            throw new Error('No valid emails found');
        }

        const validMessageIds = validMessages.map((msg) => msg.messageId);
        const messageChunks = chunkDispatchRecipients(validMessages);
        logger('Created chunks:', messageChunks.map((chunk) => chunk.length));
        const dispatchResult = await Promise.all(messageChunks.map((chunk) => dispatchEmailMessageChunk(chunk)));

        const failedChunks = dispatchResult.map((chunk) => {
            const result = JSON.parse(chunk.result)[0];
            if (!Reflect.has(result, 'statusCode') || !SUCCESS_STATUSES.includes(result.statusCode)) {
                return chunk.messageIds;
            }
            return null;
        }).filter((result) => result !== null).reduce((flatArray, currentArray) => [...flatArray, ...currentArray], []);

        const failedMessages = emailMessages.filter((message) => !validMessageIds.includes(message.messageId) || failedChunks.includes(message.messageId));
        logger('Failed messages:', failedMessages.length);

        const failedMessageIds = failedMessages.map((msg) => msg.messageId);

        return { result: 'SUCCESS', failedMessageIds };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERR', message: err.message };
    }
};
