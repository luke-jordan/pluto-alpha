'use strict';

/**
 * NOTE: this is a queue worker, in effect. It subscribes to the pub topic for user events,
 * and directs them to other lambdas and/or (in time) SQS queues and the like
 */

const config = require('config');
const format = require('string-format');
const logger = require('debug')('jupiter:event-handling');

const persistence = require('./persistence/rds');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

// for dispatching the mails & DLQ & invoking other lambdas
const ses = new AWS.SES();
const sqs = new AWS.SQS();
const sns = new AWS.SNS();
const s3 = new AWS.S3();
const lambda = new AWS.Lambda();

const Redis = require('ioredis');
const redis = new Redis({ port: config.get('cache.port'), host: config.get('cache.host') });

const sourceEmail = config.get('publishing.eventsEmailAddress');
const emailSendingEnabled = config.get('publishing.eventsEmailEnabled');

const UNIT_DIVISORS_TO_WHOLE = {
    'HUNDREDTH_CENT': 100 * 100,
    'WHOLE_CENT': 100,
    'WHOLE_CURRENCY': 1 
};

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

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

const invokeProfileLambda = async (systemWideUserId, includeContactScan) => {
    const profileFetchLambdaInvoke = invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId, includeContactScan });
    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    logger('Result of profile fetch: ', profileFetchResult);
    const profileResult = extractLambdaBody(profileFetchResult);
    const cacheTtl = config.get('cache.ttls.profile');
    // NOTE : todo: going to need to make sure cache gets invalidated when we implement / put live profile update
    logger('Fetched profile, putting in cache');
    await redis.set(`${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`, JSON.stringify(profileResult), 'EX', cacheTtl);
    return profileResult;
};

const fetchUserProfile = async (systemWideUserId, includePrimaryContact) => {
    const requiresContactScan = typeof includePrimaryContact === 'boolean' && includePrimaryContact;
    const key = `${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`;
    const cachedProfile = await redis.get(key);
    if (!cachedProfile || typeof cachedProfile !== 'string' || cachedProfile.length === 0) {
        return invokeProfileLambda(systemWideUserId, requiresContactScan);
    }

    const parsedProfile = JSON.parse(cachedProfile);
    if (includePrimaryContact && !parsedProfile.contactMethod) {
        return invokeProfileLambda(systemWideUserId, true);
    }

    return parsedProfile;
};

// /////////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// EMAIL HANDLING ////////////////////////////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////////////////

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
    Destination: { ToAddresses: toAddresses },
    Message: {
        Body: {
            Html: { Data: htmlBody },
            Text: { Data: textBody }
        },
        Subject: { Data: subject }
    },
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

const safeEmailAttempt = async (eventBody) => {
    try {
        const emailToSend = await assembleSaveEmail(eventBody);
        logger('Sending save event emails: ', emailToSend);
        const emailResult = await ses.sendEmail(emailToSend).promise();
        logger('Well where did that get us: ', emailResult);
    } catch (err) {
        logger('Email sending conked out: ', err);
    }
};

// handling withdrawals by sending email
const safeWithdrawalEmail = async (eventBody) => {
    const { userId } = eventBody;
    const key = `${config.get('cache.keyPrefixes.withdrawal')}::${userId}`;
    const [cachedDetails, userProfile] = await Promise.all([redis.get(key), fetchUserProfile(userId, true)]);
    const bankAccountDetails = JSON.parse(cachedDetails);

    const templateVariables = { ...bankAccountDetails };
    templateVariables.accountHolder = `${userProfile.personalName} ${userProfile.familyName}`;
    templateVariables.withdrawalAmount = formatAmountText(-eventBody.context.withdrawalAmount); // so that this is positive
    templateVariables.profileLink = `${config.get('publishing.adminSiteUrl')}/users/profile?userId=${userId}`;
    templateVariables.contactMethod = userProfile.contactMethod;

    const subject = 'User wants to withdraw';
    const htmlTemplate = await obtainTemplate(config.get('templates.withdrawalEmail'));
    const htmlBody = format(htmlTemplate, templateVariables);

    const textBody = 'Jupiter withdrawal requested';

    const emailParams = assembleEmailParameters({ 
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject, htmlBody, textBody
    });
    
    try {
        const emailResult = await ses.sendEmail(emailParams).promise();
        logger('Result of sending email: ', emailResult);
    } catch (err) {
        // we want the rest to execute, so we manually publish to the dlq, and alert admins
        addToDlq({ eventType: 'WITHDRAWAL', eventBody, templateVariables });
        const snsMessage = {
            Message: `Jupiter Withdrawal! Withdrawal triggered for ${userProfile.contactMethod}, but failed on email dispatch.`,
            MessageStructure: 'string',
            TopicArn: config.get('publishing.userEvents.withdrawalTopic')
        };

        logger('Sending parameters to message: ', snsMessage);
        const resultOfSns = await sns.publish(snsMessage).promise();
        logger('Result of SNS dispatch: ', resultOfSns);
    }
};

// /////////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// EVENT DISPATCHING ////////////////////////////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////////////////

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

const updateAccountTags = async (systemWideUserId, FWAccountNumber) => {
    const tag = `${config.get('defaults.balanceSheet.accountPrefix')}::${FWAccountNumber}`;
    const accountUpdateResult = await persistence.updateAccountTags(systemWideUserId, tag);
    logger('Updating account tags resulted in:', accountUpdateResult);
    return accountUpdateResult;
};

const updateTxTags = async (transactionId, flag) => {
    const txUpdateResult = await persistence.updateTxTags(transactionId, flag);
    logger('Got this back from updating tx flags:', txUpdateResult);
    
    return txUpdateResult;
};

const createFinWorksAccount = async (userDetails) => {
    logger('got user details:', userDetails);
    const accountCreationInvoke = invokeLambda(config.get('lambdas.createBalanceSheetAccount'), userDetails);
    const accountCreationResult = await lambda.invoke(accountCreationInvoke).promise();
    logger('Result of FinWorks account creation:', accountCreationResult);

    return JSON.parse(accountCreationResult['Payload']);
};

const addInvestmentToBSheet = async ({ operation, accountId, amount, unit, currency, transactionId }) => {
    // still some stuff to work out here, e.g., in syncing up the account number, so rather catch & log, and let other actions pass
    try {
        const accountNumber = await persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'));
        logger('Got third party account number:', accountNumber);

        if (!accountNumber) {
            // we don't actually throw this, but do log it, because admin needs to know
            logger('FATAL_ERROR: No FinWorks account number for user!');
            return;
        }
        
        const wholeCurrencyAmount = parseInt(amount, 10) / UNIT_DIVISORS_TO_WHOLE[unit];

        const transactionDetails = { accountNumber, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };
        const investmentInvocation = invokeLambda(config.get('lambdas.addTxToBalanceSheet'), { operation, transactionDetails });
        
        logger('lambda args:', investmentInvocation);
        const investmentResult = await lambda.invoke(investmentInvocation).promise();
        logger('Investment result from third party:', investmentResult);

        const parsedResult = JSON.parse(investmentResult['Payload']);
        logger('Got response body', parsedResult);
        if (Object.keys(parsedResult).includes('result') && parsedResult.result === 'ERROR') {
            throw new Error(`Error sending investment to third party: ${parsedResult}`);
        }

        const txUpdateResult = await updateTxTags(transactionId, config.get('defaults.balanceSheet.txFlag'));
        logger('Result of transaction update:', txUpdateResult);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
    }
};


// /////////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////// CORE DISPATCHERS //////////////////////////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////////////////

const handleSavingEvent = async (eventBody) => {
    logger('Saving event triggered!: ', eventBody);

    const promisesToInvoke = [];
        
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    promisesToInvoke.push(lambda.invoke(boostProcessInvocation).promise());
    
    if (emailSendingEnabled) {
        promisesToInvoke.push(safeEmailAttempt(eventBody));
    }

    const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_SAVED', reasonToLog: 'Saving event completed' }};
    const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
    promisesToInvoke.push(lambda.invoke(statusInvocation).promise());
    
    const accountId = eventBody.context.accountId;
    const transactionId = eventBody.context.transactionId;
    const [amount, unit, currency] = eventBody.context.savedAmount.split('::');
    promisesToInvoke.push(addInvestmentToBSheet({ operation: 'INVEST', accountId, transactionId, amount, unit, currency }));

    await Promise.all(promisesToInvoke);
};

const handleWithdrawalEvent = async (eventBody) => {
    logger('Withdrawal event triggered!');

    await safeWithdrawalEmail(eventBody);

    const processingPromises = [];
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    processingPromises.push(lambda.invoke(boostProcessInvocation).promise());

    const accountId = eventBody.context.accountId;
    const [amount, unit, currency] = eventBody.context.withdrawalAmount.split('::');
    processingPromises.push(addInvestmentToBSheet({ operation: 'WITHDRAW', accountId, amount: Math.abs(amount), unit, currency }));

    const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_WITHDRAWN', reasonToLog: 'User withdrew funds' }};
    const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
    logger('Status invocation: ', statusInvocation);
    processingPromises.push(lambda.invoke(statusInvocation).promise());

    await Promise.all(processingPromises);
};

const handleAccountOpenedEvent = async (eventBody) => {
    logger('Handling event:', eventBody);

    const userProfile = await fetchUserProfile(eventBody.userId);
    const userDetails = { idNumber: userProfile.nationalId, surname: userProfile.familyName, firstNames: userProfile.personalName };
    const bsheetAccountResult = await createFinWorksAccount(userDetails);
    if (typeof bsheetAccountResult !== 'object' || !Object.keys(bsheetAccountResult).includes('accountNumber')) {
        throw new Error(`Error creating user FinWorks account: ${bsheetAccountResult}`);
    }

    logger('Finworks account creation resulted in:', bsheetAccountResult);
    const accountUpdateResult = await updateAccountTags(eventBody.userId, bsheetAccountResult.accountNumber);
    logger(`Result of user account update: ${accountUpdateResult}`);
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
            case 'USER_CREATED_ACCOUNT':
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
