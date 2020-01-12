'use strict';

const logger = require('debug')('jupiter:third-parties:sendgrid');
const uuid = require('uuid/v4');
const config = require('config');
const validator = require('validator');
const sgMail = require('@sendgrid/mail');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

sgMail.setApiKey(config.get('sendgrid.apiKey'));

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

const validateTemplate = (templateDetails) => {
    if (!templateDetails.templateId || !validator.isUUID(templateDetails.templateId, 4)) {
        throw new Error('Missing or invalid template id');
    }

    if (!templateDetails.htmlTemplate && !templateDetails.textTemplate) {
        throw new Error('You must provide either a text or html template or both');
    }

    if (templateDetails.htmlTemplate && typeof templateDetails.htmlTemplate !== 'string') {
        throw new Error(`Invalid HTML template: ${JSON.stringify(templateDetails.htmlTemplate)}`);
    }

    if (templateDetails.textTemplate && typeof templateDetails.textTemplate !== 'string') {
        throw new Error(`Invalid text template: ${JSON.stringify(templateDetails.textTemplate)}`);
    }
};

const assembleEmail = (templateDetails, destinationDetails) => {
    const { templateId, subject, htmlTemplate, textTemplate } = templateDetails;
    const { emailAddress, templateVariables } = destinationDetails;

    const body = {
        'to': emailAddress,
        'from': config.get('sendgrid.sourceAddress'),
        'subject': subject,
        'template_id': templateId,
        'dynamic_template_data': templateVariables,
        'mail_settings': {
            'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
        }
    };

    if (textTemplate) {
        body.text = textTemplate;
    }

    if (htmlTemplate) {
        body.html = htmlTemplate;
    }

    logger('Assembled body:', body);
    return body;
};

const publishEmails = async (email) => {
    try {
        const result = await sgMail.send(email);
        // logger('Result of email dispatch:', result);
        const formattedResult = { statusCode: result[0].statusCode, statusMessage: result[0].statusMessage, templateId: email.template_id, toAdrress: email.to };

        return formattedResult;
    } catch (err) {
        logger(`Error sending email: ${err}`);
        return { error: err.message, templateId: email.template_id, toAdrress: email.to };
    }
};

/**
 * This function sends emails to provided addresses. The email template is stored remotely and a locator key-bucket pair is required.
 * @param {object} event 
 * @property {object} templateSource An object whose properties are the s3 key and bucket containing the emails html template.
 * @property {string} textTemplate The emails text template.
 * @property {subject} subject The emails subject.
 * @property {array} destinationArray An array containing destination objects. Each destination object contains an 'emailAddress' and 'templateVariables' property. These contain target email and template variables respectively.
 */
module.exports.publishFromSource = async ({templateSource, textTemplate, subject, destinationArray}) => {
    validatePublishEvent({ subject, templateSource, textTemplate, destinationArray });

    const templateId = uuid();

    const templateDetails = { subject, destinationArray };
    templateDetails.templateId = templateId;

    if (templateSource) {
        const { bucket, key } = templateSource;
        templateDetails.htmlTemplate = await obtainHtmlTemplate(bucket, key);
    }

    if (textTemplate) {
        templateDetails.textTemplate = textTemplate;
    }

    validateTemplate(templateDetails);

    const resultOfPublish = await Promise.all(destinationArray.map((destinationDetails) => publishEmails(assembleEmail(templateDetails, destinationDetails))));
    // DLQ failed emails?

    logger('Result of email send: ', resultOfPublish);
    
    return { result: 'SUCCESS' };
};


/**
 * This function sends emails to provided addresses.
 * @param {object} event 
 * @property {object} htmlTemplate The emails html template.
 * @property {string} textTemplate The emails text template.
 * @property {subject} subject The emails subject.
 * @property {array} destinationArray An array containing destination objects. Each destination object contains an 'emailAddress' and 'templateVariables' property. These contain target email and template variables respectively.
 */
module.exports.publishFromTemplate = async ({htmlTemplate, textTemplate, subject, destinationArray}) => {
    validatePublishEvent({ subject, htmlTemplate, textTemplate, destinationArray });

    const templateId = uuid();

    const templateDetails = { subject, htmlTemplate, destinationArray };
    templateDetails.templateId = templateId;

    if (textTemplate) {
        templateDetails.textTemplate = textTemplate;
    }

    validateTemplate(templateDetails);

    const resultOfPublish = await Promise.all(destinationArray.map((destinationDetails) => publishEmails(assembleEmail(templateDetails, destinationDetails))));

    logger('Result of email send: ', resultOfPublish);
    
    return { result: 'SUCCESS' };
};
