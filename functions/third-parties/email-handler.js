'use strict';

const logger = require('debug')('jupiter:third-parties:sendgrid');
const config = require('config');
const sendGridMail = require('@sendgrid/mail');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

sendGridMail.setApiKey(config.get('sendgrid.apiKey'));
sendGridMail.setSubstitutionWrappers('{{', '}}');

const obtainHtmlTemplate = async (Bucket, Key) => {
    const template = await s3.getObject({ Bucket, Key }).promise();
    return template.Body.toString('ascii');
};

const validatePublishEvent = ({ subject, templateSource, htmlTemplate, textTemplate, destinationArray }) => {
    if (!templateSource && !htmlTemplate && !textTemplate) {
        throw new Error('At least one template is required');
    }
     
    if (templateSource) {
        if (!Reflect.has(templateSource, 'bucket') || !Reflect.has(templateSource, 'key')) {
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

const validateTemplate = (dispatchDetails) => {
    if (!dispatchDetails.htmlTemplate && !dispatchDetails.textTemplate) {
        throw new Error('You must provide either a text or html template or both');
    }

    if (dispatchDetails.htmlTemplate && typeof dispatchDetails.htmlTemplate !== 'string') {
        throw new Error(`Invalid HTML template: ${JSON.stringify(dispatchDetails.htmlTemplate)}`);
    }

    if (dispatchDetails.textTemplate && typeof dispatchDetails.textTemplate !== 'string') {
        throw new Error(`Invalid text template: ${JSON.stringify(dispatchDetails.textTemplate)}`);
    }
};

const assembleEmails = (dispatchDetails) => {
    const { subject, htmlTemplate, textTemplate, destinationArray } = dispatchDetails;

    const email = {
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

    email.personalizations = personalizationsArray;

    if (textTemplate) {
        email.content.push({ 'type': 'text/plain', 'value': textTemplate });
    }

    if (htmlTemplate) {
        email.content.push({ 'type': 'text/html', 'value': htmlTemplate });
    }

    logger('Assembled body:', JSON.stringify(email));
    return email;
};

/**
 * This function sends emails to provided addresses. The email template is stored remotely and a locator key-bucket pair is required.
 * @param {object} event 
 * @property {object} templateSource An object whose properties are the s3 key and bucket containing the emails html template.
 * @property {string} textTemplate The emails text template.
 * @property {subject} subject The emails subject.
 * @property {array} destinationArray An array containing destination objects. Each destination object contains an 'emailAddress' and 'templateVariables' property.
 * These contain target email and template variables respectively.
 */
module.exports.publishFromSource = async ({ templateSource, textTemplate, subject, destinationArray }) => {
    validatePublishEvent({ subject, templateSource, textTemplate, destinationArray });

    const dispatchDetails = { subject, destinationArray };

    if (templateSource) {
        const { bucket, key } = templateSource;
        dispatchDetails.htmlTemplate = await obtainHtmlTemplate(bucket, key);
    }

    if (textTemplate) {
        dispatchDetails.textTemplate = textTemplate;
    }

    validateTemplate(dispatchDetails);

    const assembledEmails = assembleEmails(dispatchDetails, destinationArray);

    const resultOfEmails = await sendGridMail.send(assembledEmails);

    const formattedResult = { statusCode: resultOfEmails[0].statusCode, statusMessage: resultOfEmails[0].statusMessage };
    logger('Result of email send: ', formattedResult);
    
    return { result: 'SUCCESS' };
};

/**
 * This function sends emails to provided addresses.
 * @param {object} event 
 * @property {object} htmlTemplate The emails html template.
 * @property {string} textTemplate The emails text template.
 * @property {subject} subject The emails subject.
 * @property {array} destinationArray An array containing destination objects. Each destination object contains an 'emailAddress' and 'templateVariables' property.
 * These contain target email and template variables respectively.
 */
module.exports.publishFromTemplate = async ({ htmlTemplate, textTemplate, subject, destinationArray }) => {
    validatePublishEvent({ subject, htmlTemplate, textTemplate, destinationArray });

    const dispatchDetails = { subject, htmlTemplate, destinationArray };

    if (textTemplate) {
        dispatchDetails.textTemplate = textTemplate;
    }

    validateTemplate(dispatchDetails);

    const assembledEmails = assembleEmails(dispatchDetails, destinationArray);

    const resultOfEmails = await sendGridMail.send(assembledEmails);

    const formattedResult = { statusCode: resultOfEmails[0].statusCode, statusMessage: resultOfEmails[0].statusMessage };
    logger('Result of email send: ', formattedResult);
    
    return { result: 'SUCCESS' };
};
