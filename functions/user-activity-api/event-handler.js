'use strict';

/**
 * NOTE: this is a queue worker, in effect. It subscribes to the pub topic for user events,
 * and directs them to other lambdas and/or (in time) SQS queues and the like
 */

const config = require('config');
const logger = require('debug')('jupiter:event-handling');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

// for dispatching the mails & DLQ & invoking other lambdas
const ses = new AWS.SES();
const sqs = new AWS.SQS();
const lambda = new AWS.Lambda();

const sourceEmail = config.get('publishing.eventsEmailAddress');

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

const assembleEmail = ({ toAddresses, subject, htmlBody, textBody }) => ({
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

const assembleSaveEmail = (eventBody) => {
    const toAddresses = config.get('publishing.saveEmailDestination');
    const subject = 'Yippie kay-yay';
    const htmlBody = '<p>Someone did the needful</p>';
    const textBody = 'Really?';

    return assembleEmail({ toAddresses, subject, htmlBody, textBody });
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

    const emailToSend = assembleSaveEmail(eventBody);
    const emailResult = await ses.sendEmail(emailToSend).promise();
    logger('Well where did that get us: ', emailResult);
    
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    const resultOfInvoke = await lambda.invoke(boostProcessInvocation).promise();
    logger('Result of invoking boost process: ', resultOfInvoke);
};

const handleWithdrawalEvent = async (eventBody) => {
    const subject = 'Damn it the bastard';
    const htmlBody = '<p>Ah crap, someone withdrew some money<p>';
    const textBody = 'This seems gratuitous';

    const emailParams = assembleEmail({ 
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject, htmlBody, textBody
    })
    
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
