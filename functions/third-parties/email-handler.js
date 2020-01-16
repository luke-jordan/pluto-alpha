'use strict';

const logger = require('debug')('jupiter:third-parties:sendgrid');
const config = require('config');
const opsUtil = require('ops-util-common');

const sendGridMail = require('@sendgrid/mail');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

sendGridMail.setApiKey(config.get('sendgrid.apiKey'));
sendGridMail.setSubstitutionWrappers('{{', '}}');

const obtainHtmlTemplate = async (Bucket, Key) => {
    const template = await s3.getObject({ Bucket, Key }).promise();
    return template.Body.toString('ascii');
};

const validateDispatchEvent = ({ subject, templateKeyBucket, htmlTemplate, textTemplate, destinationArray }) => {
    if (!templateKeyBucket && !htmlTemplate && !textTemplate) {
        throw new Error('At least one template is required');
    }
     
    if (templateKeyBucket) {
        if (!Reflect.has(templateKeyBucket, 'bucket') || !Reflect.has(templateKeyBucket, 'key')) {
            throw new Error('Missing valid template key-bucket pair');
        }
    }

    if (!Array.isArray(destinationArray) || destinationArray.length === 0) {
        throw new Error('Missing destination array');
    }

    if (destinationArray.length > 1000) {
        throw new Error('Cannot send to more than 1000 recipients at a time');
    }

    destinationArray.forEach((destination) => {
        if (typeof destination !== 'object' || Object.keys(destination).length === 0) {
            throw new Error(`Invalid destination object: ${JSON.stringify(destination)}`);
        }

        if (!destination.emailAddress || !destination.templateVariables) {
            throw new Error(`Invalid destination object: ${JSON.stringify(destination)}`);
        }
    });

    if (!subject) {
        throw new Error('Missing email subject');
    }
};

const validateDispatchParams = (dispatchParams) => {
    if (!dispatchParams.htmlTemplate && !dispatchParams.textTemplate) {
        throw new Error('You must provide either a text or html template or both');
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
                throw new Error('No values found for property: ${property}');
            }
        }
    });

    if (!payload.from.email) {
        throw new Error('Configuration error. Missing payload source email address');
    }
};

const assembleDispatchPayload = (dispatchParams) => {
    const { subject, htmlTemplate, textTemplate, destinationArray } = dispatchParams;

    const payload = {
        'from': {
            'email': config.get('sendgrid.fromAddress'),
            'name': 'Jupiter'
        },
        'reply_to': {
            'email': config.get('sendgrid.replyToAddress'),
            'name': 'Jupiter'
        },
        'subject': '{{subject}}',
        'content': [],
        'mail_settings': {
            'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
        }
    };

    const personalizationsArray = [];
    destinationArray.forEach((destination) => {
        const substitutions = destination.templateVariables;
        substitutions.subject = subject;
        personalizationsArray.push({
            to: [{ email: destination.emailAddress }],
            substitutions
        });
    });

    payload.personalizations = personalizationsArray;

    if (textTemplate) {
        payload.content.push({ 'type': 'text/plain', 'value': textTemplate });
    }

    if (htmlTemplate) {
        payload.content.push({ 'type': 'text/html', 'value': htmlTemplate });
    }

    logger('Assembled body:', JSON.stringify(payload));
    return payload;
};

/**
 * This function sends emails to provided addresses. The email template is stored remotely and a locator key-bucket pair is required.
 * @param {object} event 
 * @property {object} templateKeyBucket An object whose properties are the s3 key and bucket containing the emails html template.
 * @property {string} textTemplate The emails text template.
 * @property {subject} subject The emails subject.
 * @property {array} destinationArray An array containing destination objects. Each destination object contains an 'emailAddress' and 'templateVariables' property. These contain target email and template variables respectively.
 */
module.exports.sendEmailsFromSource = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            return { result: 'Empty invocation' };
        }

        const { subject, templateKeyBucket, textTemplate, destinationArray } = opsUtil.extractParamsFromEvent(event);
        validateDispatchEvent({ subject, templateKeyBucket, textTemplate, destinationArray });

        const dispatchParams = { subject, destinationArray };

        if (templateKeyBucket) {
            const { bucket, key } = templateKeyBucket;
            dispatchParams.htmlTemplate = await obtainHtmlTemplate(bucket, key);
        }

        if (textTemplate) {
            dispatchParams.textTemplate = textTemplate;
        }

        validateDispatchParams(dispatchParams);

        const dispatchPayload = assembleDispatchPayload(dispatchParams, destinationArray);

        validateDispatchPayload(dispatchPayload);

        const resultOfDispatch = await sendGridMail.send(dispatchPayload);

        const formattedResult = { statusCode: resultOfDispatch[0].statusCode, statusMessage: resultOfDispatch[0].statusMessage };
        logger('Result of email send: ', formattedResult);
        
        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERR', message: err.message };
    }
};

/**
 * This function sends emails to provided addresses.
 * @param {object} event 
 * @property {object} htmlTemplate The emails html template.
 * @property {string} textTemplate The emails text template.
 * @property {subject} subject The emails subject.
 * @property {array} destinationArray An array containing destination objects. Each destination object contains an 'emailAddress' and 'templateVariables' property. These contain target email and template variables respectively.
 */
module.exports.sendEmails = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            return { result: 'Empty invocation' };
        }

        const { subject, htmlTemplate, textTemplate, destinationArray } = opsUtil.extractParamsFromEvent(event);
        validateDispatchEvent({ subject, htmlTemplate, textTemplate, destinationArray });

        const dispatchParams = { subject, htmlTemplate, destinationArray };

        if (textTemplate) {
            dispatchParams.textTemplate = textTemplate;
        }

        validateDispatchParams(dispatchParams);

        const dispatchPayload = assembleDispatchPayload(dispatchParams, destinationArray);

        validateDispatchPayload(dispatchPayload);

        const resultOfDispatch = await sendGridMail.send(dispatchPayload);

        const formattedResult = { statusCode: resultOfDispatch[0].statusCode, statusMessage: resultOfDispatch[0].statusMessage };
        logger('Result of email send: ', formattedResult);
        
        return { result: 'SUCCESS' };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERR', message: err.message };
    }
};
