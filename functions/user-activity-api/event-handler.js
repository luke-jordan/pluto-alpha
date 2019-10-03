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
        case 1:     countText = 'first'; break;
        case 2:     countText = 'second'; break;
        case 3:     countText = 'third'; break;
        default:    countText = `${saveContext.count}th`; 
    }
    templateVariables.saveCountText = countText;
    templateVariables.profileLink = `${config.get('publishing.adminSiteUrl')}/users/profile?userId=${eventBody.userId}`;
    
    const toAddresses = config.get('publishing.saveEmailDestination');
    const subject = 'Yippie kay-yay';
    
    const htmlTemplate = await obtainTemplate(config.get('templates.saveEmail'));
    const htmlBody = format(htmlTemplate, templateVariables);
    const textBody = 'Error. Tell system admin text emails still live.';

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

const handleSavingEvent = async (eventBody) => {
    logger('Saving event triggered!: ', eventBody);
        
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    const resultOfInvoke = await lambda.invoke(boostProcessInvocation).promise();
    logger('Result of invoking boost process: ', resultOfInvoke);

    const emailToSend = await assembleSaveEmail(eventBody);
    logger('Sending save event emails: ', emailToSend);
    const emailResult = await ses.sendEmail(emailToSend).promise();
    logger('Well where did that get us: ', emailResult);

};

const handleWithdrawalEvent = async (eventBody) => {
    const userId = eventBody.userId;
    const key = `${userId}::BANK_DETAILS`;
    const cachedDetails = await redis.get(key);
    const bankAccountDetails = JSON.parse(cachedDetails);

    const templateVariables = Object.assign({}, bankAccountDetails);
    templateVariables.withdrawalAmount = formatAmountText(eventBody.context.withdrawalAmount);
    templateVariables.profileLink = `${config.get('publishing.adminSiteUrl')}/users/profile?userId=${userId}`;

    const subject = 'Withdrawal requested';
    const htmlTemplate = await obtainTemplate('emails/withdrawalEmail.html');
    const htmlBody = format(htmlTemplate, templateVariables);

    const textBody = 'Unnecessary';

    const emailParams = assembleEmailParameters({ 
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject, htmlBody, textBody
    });
    
    const emailResult = await ses.sendEmail(emailParams).promise();
    logger('Result of sending email: ', emailResult);

    // then do anything else the seems important
};

const handleAccountOpenedEvent = async (eventBody) => {
    logger('Account open handled!: ', accountOpened);
};

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