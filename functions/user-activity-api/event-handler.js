'use strict';

/**
 * NOTE: this is a queue worker, in effect. It subscribes to the pub topic for user events,
 * and directs them to other lambdas and/or (in time) SQS queues and the like
 */

const config = require('config');
const format = require('string-format');
const logger = require('debug')('jupiter:event-handling');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

// for dispatching the mails & DLQ & invoking other lambdas
const ses = new AWS.SES();
const sqs = new AWS.SQS();
const s3 = new AWS.S3();
const lambda = new AWS.Lambda();

const Redis = require('ioredis');
const redis = new Redis({ port: config.get('cache.port'), host: config.get('cache.host') });

const sourceEmail = config.get('publishing.eventsEmailAddress');

const UNIT_DIVISORS_TO_WHOLE = {
    'HUNDREDTH_CENT': 100 * 100,
    'WHOLE_CENT': 100,
    'WHOLE_CURRENCY': 1 
};

const extractSnsMessage = async (snsEvent) => JSON.parse(snsEvent.Records[0].Sns.Message);

const addToDlq = async (event, err) => {
    const dlqName = config.get('publishing.userEvents.processingDlq');
    logger('Looking for DLQ name: ', dlqName);
    const dlqUrlResult = await sqs.getQueueUrl({ QueueName: dlqName }).promise();
    const dlqUrl = dlqUrlResult.QueueUrl;

    const payload = { event, err };
    const params = {
        MessageAttributes: {
            MessageBodyDataType: {
                DataType: 'String',
                StringValue: 'JSON'
            }
        },
        MessageBody: JSON.stringify(payload),
        QueueUrl: dlqUrl
    };

    logger('Sending to SQS DLQ: ', params);
    const sqsResult = await sqs.sendMessage(params).promise();
    logger('Result of sqs transmission:', sqsResult);
};

const obtainTemplate = async (templateName) => {
    const templateBucket = config.get('templates.bucket');
    logger(`Getting template from bucket ${templateBucket} and key, ${templateName}`);
    const s3result = await s3.getObject({ Bucket: templateBucket, Key: templateName }).promise();
    const templateText = s3result.Body.toString('utf-8');
    return templateText;
};

const formatAmountText = (amountText) => {
    logger('Formatting amount text: ', amountText);
    if (!amountText || amountText.length === 0) {
        return 'Error. Check logs';
    }

    const [amount, unit, currency] = amountText.split('::');
    const amountResult = { amount, unit, currency };
    logger('Split amount: ', amountResult);

    const wholeCurrencyAmount = amountResult.amount / UNIT_DIVISORS_TO_WHOLE[amountResult.unit];

    // JS's i18n for emerging market currencies is lousy, and gives back the 3 digit code instead of symbol, so have to hack for those
    // implement for those countries where client opcos have launched
    if (amountResult.currency === 'ZAR') {
        const emFormat = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
        return `R${emFormat.format(wholeCurrencyAmount)}`;
    }

    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: amountResult.currency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    });
    
    return numberFormat.format(wholeCurrencyAmount);
};

const assembleEmailParameters = ({ toAddresses, subject, htmlBody, textBody }) => ({
    Destination: {
        ToAddresses: toAddresses
    },
    Message: { Body: { 
        Html: { Data: htmlBody },
        Text: { Data: textBody }
    },
    Subject: { Data: subject }},
    Source: sourceEmail,
    ReplyToAddresses: [sourceEmail],
    ReturnPath: sourceEmail
});

const assembleSaveEmail = async (eventBody) => {
    const saveContext = eventBody.context;
    const templateVariables = {};
    templateVariables.savedAmount = formatAmountText(saveContext.savedAmount);
    let countText = '';
    switch (saveContext.saveCount) {
        case 1: 
            countText = 'first'; 
            break;
        case 2: 
            countText = 'second';
            break;
        case 3: 
            countText = 'third'; 
            break;
        default: 
            countText = `${saveContext.saveCount}th`; 
    }

    templateVariables.saveCountText = countText;
    templateVariables.profileLink = `${config.get('publishing.adminSiteUrl')}/users/profile?userId=${eventBody.userId}`;
    
    const toAddresses = config.get('publishing.saveEmailDestination');
    const subject = 'Yippie kay-yay';
    
    const htmlTemplate = await obtainTemplate(config.get('templates.saveEmail'));
    const htmlBody = format(htmlTemplate, templateVariables);
    const textBody = `A user just made their ${countText} save`;

    const emailParams = { toAddresses, subject, htmlBody, textBody };
    logger('Assembling email parameters: ', emailParams);
    return assembleEmailParameters(emailParams);
};

const assembleBoostProcessInvocation = (eventBody) => {
    const eventPayload = {
        eventType: eventBody.eventType,
        timeInMillis: eventBody.timeInMillis,
        accountId: eventBody.context.accountId,
        eventContext: eventBody.context
    };

    const invokeParams = {
        FunctionName: config.get('publishing.processingLambdas.boosts'),
        InvocationType: 'Event',
        Payload: JSON.stringify(eventPayload)
    };

    logger('Lambda invocation for boost processing: ', invokeParams);
    return invokeParams;
};

const assembleStatusUpdateInvocation = (systemWideUserId, statusInstruction) => {
    const statusRequest = {
        systemWideUserId: systemWideUserId,
        ...statusInstruction
    };

    const invokeParams = {
        FunctionName: config.get('publishing.processingLambdas.status'),
        InvocationType: 'Event',
        Payload: JSON.stringify(statusRequest)
    };
    
    return invokeParams;
};

const safeEmailAttempt = async (eventBody) => {
    try {
        const emailToSend = await assembleSaveEmail(eventBody);
        logger('Sending save event emails: ', emailToSend);
        const emailResult = await ses.sendEmail(emailToSend).promise();
        logger('Well where did that get us: ', emailResult);
    } catch (err) {
        logger('Email sending conked out: ', err);
    }
}

// todo : parallelize, obviously
const handleSavingEvent = async (eventBody) => {
    logger('Saving event triggered!: ', eventBody);
        
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    const resultOfInvoke = await lambda.invoke(boostProcessInvocation).promise();
    logger('Result of invoking boost process: ', resultOfInvoke);

    const sendEmail = config.get('publishing.eventsEmailEnabled');
    if (sendEmail) {
        await safeEmailAttempt(eventBody);
    }

    // todo : in time, make sure that this doesn't go backwards
    const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_SAVED', reasonToLog: 'Saving event completed' }};
    const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
    const statusResult = await lambda.invoke(statusInvocation).promise();
    logger('Result of lambda invoke: ', statusResult);
};

const handleWithdrawalEvent = async (eventBody) => {
    const userId = eventBody.userId;
    const key = `${userId}::BANK_DETAILS`;
    const cachedDetails = await redis.get(key);
    const bankAccountDetails = JSON.parse(cachedDetails);

    const templateVariables = { ...bankAccountDetails };
    templateVariables.withdrawalAmount = formatAmountText(eventBody.context.withdrawalAmount);
    templateVariables.profileLink = `${config.get('publishing.adminSiteUrl')}/users/profile?userId=${userId}`;

    const subject = 'Withdrawal requested';
    const htmlTemplate = await obtainTemplate(config.get('templates.withdrawalEmail'));
    const htmlBody = format(htmlTemplate, templateVariables);

    const textBody = 'Unnecessary';

    const emailParams = assembleEmailParameters({ 
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject, htmlBody, textBody
    });
    
    const emailResult = await ses.sendEmail(emailParams).promise();
    logger('Result of sending email: ', emailResult);

    // todo : as above, make sure doesn't alter status backwards
    // const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_WITHDRAWN', reasonToLog: 'User withdrew funds' }};
};

const handleAccountOpenedEvent = async (eventBody) => {
    logger('Account open handled!: ', eventBody);
};

/**
 * This function handles successful account opening, saving, and withdrawal events. It is typically called by SNS. The following properties are expected in the SNS message:
 * @param {object} snsEvent An SNS event object containing our parameter(s) of interest in its Message property.
 * @property {string} eventType The type of event to be processed. Valid values are SAVING_PAYMENT_SUCCESSFUL, WITHDRAWAL_EVENT_CONFIRMED, and PASSWORD_SET (for opened accounts).
 */
module.exports.handleUserEvent = async (snsEvent) => {
    try {
        const eventBody = await extractSnsMessage(snsEvent);
        const eventType = eventBody.eventType;
        switch (eventType) {
            case 'SAVING_PAYMENT_SUCCESSFUL':
                await handleSavingEvent(eventBody);
                break;
            case 'WITHDRAWAL_EVENT_CONFIRMED':
                await handleWithdrawalEvent(eventBody);
                break;
            case 'PASSWORD_SET':
                await handleAccountOpenedEvent(eventBody);
                break; 
            default:
                logger(`We don't handle ${eventType}, let it pass`);
        }

        return { statusCode: 200 };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        await addToDlq(snsEvent, err);
        return { statusCode: 500 };
    }
};
