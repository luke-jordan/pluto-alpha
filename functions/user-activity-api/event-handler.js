'use strict';

/**
 * NOTE: this is a queue worker, in effect. It subscribes to the pub topic for user events,
 * and directs them to other lambdas and/or (in time) SQS queues and the like
 */

const config = require('config');
const format = require('string-format');
const htmlToText = require('html-to-text');

const logger = require('debug')('jupiter:event-handling:main');

const publisher = require('publish-common');
const persistence = require('./persistence/rds');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

// for dispatching the mails & DLQ & invoking other lambdas
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

const invokeProfileLambda = async (systemWideUserId, includeContactMethod) => {
    const profileFetchLambdaInvoke = invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId, includeContactMethod });
    logger('Invoke profile fetch with arguments: ', profileFetchLambdaInvoke);
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
    logger(`Fetching profile in event process, passed includePrimaryContact: ${includePrimaryContact} and sending on: ${requiresContactScan}`);
    const key = `${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`;
    const cachedProfile = await redis.get(key);
    if (!cachedProfile || typeof cachedProfile !== 'string' || cachedProfile.length === 0) {
        return invokeProfileLambda(systemWideUserId, requiresContactScan);
    }

    const parsedProfile = JSON.parse(cachedProfile);
    if (requiresContactScan && !parsedProfile.emailAddress && !parsedProfile.phoneNumber) {
        logger('Required contact scan but not present in profile, so fetching');
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

const formatAmountDict = ({ amount, unit, currency }) => {
    const wholeCurrencyAmount = amount / UNIT_DIVISORS_TO_WHOLE[unit];

    // JS's i18n for emerging market currencies is lousy, and gives back the 3 digit code instead of symbol, so have to hack for those
    // implement for those countries where client opcos have launched
    if (currency === 'ZAR') {
        const emFormat = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
        return `R${emFormat.format(wholeCurrencyAmount)}`;
    }

    const numberFormat = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    });
    
    return numberFormat.format(wholeCurrencyAmount);
};

const formatAmountText = (amountText) => {
    logger('Formatting amount text: ', amountText);
    if (!amountText || amountText.length === 0) {
        return 'Error. Check logs';
    }

    const [amount, unit, currency] = amountText.split('::');
    const amountResult = { amount, unit, currency };
    logger('Split amount: ', amountResult);

    return formatAmountDict(amountResult);
};

const assembleEmailParameters = ({ toAddresses, subject, htmlBody, textBody }) => ({
    to: toAddresses,
    from: sourceEmail,
    subject,
    html: htmlBody,
    text: textBody
});

const profileLink = (bankReference) => {
    const profileSearch = `users?searchValue=${encodeURIComponent(bankReference)}&searchType=bankReference`;
    return `${config.get('publishing.adminSiteUrl')}/#/${profileSearch}`;
};

const sendEftInboundEmail = async (eventContext) => {
    if (!eventContext) {
        return;
    }

    const { saveInformation, initiationResult } = eventContext;

    const emailVariables = { 
        savedAmount: formatAmountDict(saveInformation), 
        bankReference: initiationResult.humanReference,
        profileLink: profileLink(initiationResult.humanReference)
    };

    const htmlTemplate = await obtainTemplate(config.get('templates.eftEmail'));
    const htmlBody = format(htmlTemplate, emailVariables);
    const textBody = htmlToText.fromString(htmlBody, { wordwrap: 80 });

    const toAddresses = config.get('publishing.saveEmailDestination');
    const emailParams = { toAddresses, subject: 'EFT transfer initiated', htmlBody, textBody };
    
    const emailToSend = assembleEmailParameters(emailParams);
    return publisher.safeEmailSendPlain(emailToSend);
};

const assembleSaveEmail = async (eventBody) => {
    const saveContext = eventBody.context;
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

    const templateVariables = {
        savedAmount: formatAmountText(saveContext.savedAmount),
        saveCountText: countText,
        bankReference: saveContext.bankReference,
        profileLink: profileLink(saveContext.bankReference)    
    };
    
    const toAddresses = config.get('publishing.saveEmailDestination');
    const subject = 'Yippie kay-yay';
    
    const htmlTemplate = await obtainTemplate(config.get('templates.saveEmail'));
    const htmlBody = format(htmlTemplate, templateVariables);
    const textBody = `A user just made their ${countText} save`;

    const emailParams = { toAddresses, subject, htmlBody, textBody };
    logger('Assembling email parameters: ', emailParams);
    return assembleEmailParameters(emailParams);
};

const sendSaveSucceededEmail = async (eventBody) => {
    const emailToSend = await assembleSaveEmail(eventBody);
    logger('Assembled email to send: ', emailToSend);
    const emailResult = await publisher.safeEmailSendPlain(emailToSend);
    logger('And email result: ', emailResult);
    return emailResult;
};

// handling withdrawals by sending email
const safeWithdrawalEmail = async (eventBody, userProfile, bankAccountDetails) => {
    const templateVariables = { ...bankAccountDetails };
    templateVariables.withdrawalAmount = formatAmountText(eventBody.context.withdrawalAmount); // note: make positive in time

    const contactMethod = userProfile.emailAddress || userProfile.phoneNumber;
    const profileSearch = `users?searchValue=${encodeURIComponent(contactMethod)}&searchType=phoneOrEmail`;
    templateVariables.profileLink = `${config.get('publishing.adminSiteUrl')}/#/${profileSearch}`;
    templateVariables.contactMethod = contactMethod;

    const subject = 'User wants to withdraw';
    const htmlTemplate = await obtainTemplate(config.get('templates.withdrawalEmail'));
    const htmlBody = format(htmlTemplate, templateVariables);

    const textBody = 'Jupiter withdrawal requested';

    const emailParams = assembleEmailParameters({ 
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject, htmlBody, textBody
    });
    
    try {
        const emailResult = await publisher.safeEmailSendPlain(emailParams);
        logger('Result of sending email: ', emailResult);
    } catch (err) {
        // we want the rest to execute, so we manually publish to the dlq, and alert admins
        addToDlq({ eventType: 'WITHDRAWAL', eventBody, templateVariables });
        const snsMessage = {
            Message: `Jupiter Withdrawal! Withdrawal triggered for ${contactMethod}, but failed on email dispatch.`,
            MessageStructure: 'string',
            TopicArn: config.get('publishing.userEvents.withdrawalTopic')
        };

        logger('Sending parameters to message: ', snsMessage);
        const resultOfSns = await sns.publish(snsMessage).promise();
        logger('Result of SNS dispatch: ', resultOfSns);
    }
};

// this will be rare so just do a simple one
const withdrawalCancelledEMail = async (userProfile, transactionDetails) => {
    const userName = `${userProfile.personalName} ${userProfile.familyName}`;
    const htmlBody = `<p>Hello,</p><p>Good news! ${userName} has decided to cancel their withdrawal. This was sent with ` +
        `bank reference, ${transactionDetails.humanReference}. Please abort the withdrawal!</p><p>The Jupiter System</p>`;
    const textBody = `${userName} cancelled their withdrawal`;
    const emailParams = assembleEmailParameters({
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject: 'Jupiter withdrawal cancelled', 
        htmlBody, textBody
    });
    const emailResult = await publisher.sendEmail(emailParams);
    logger('Result of sending email: ', emailResult);
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

const addInvestmentToBSheet = async ({ operation, accountId, amount, unit, currency, transactionId, bankDetails }) => {
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
        if (operation === 'WITHDRAW') {
            transactionDetails.bankDetails = bankDetails;
        }
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

const handleAccountOpenedEvent = async (eventBody) => {
    logger('Handling event:', eventBody);
    const { userId } = eventBody;
    const [userProfile, accountInfo] = await Promise.all([fetchUserProfile(userId), persistence.findHumanRefForUser(userId)]);
    logger('Result of account info retrieval: ', accountInfo);
    const userDetails = { idNumber: userProfile.nationalId, surname: userProfile.familyName, firstNames: userProfile.personalName };
    if (Array.isArray(accountInfo) && accountInfo.length > 0) {
        userDetails.humanRef = accountInfo[0].humanRef;
    }
    const bsheetAccountResult = await createFinWorksAccount(userDetails);
    if (typeof bsheetAccountResult !== 'object' || !Object.keys(bsheetAccountResult).includes('accountNumber')) {
        throw new Error(`Error creating user FinWorks account: ${bsheetAccountResult}`);
    }

    logger('Finworks account creation resulted in:', bsheetAccountResult);
    const accountUpdateResult = await updateAccountTags(eventBody.userId, bsheetAccountResult.accountNumber);
    logger(`Result of user account update: ${accountUpdateResult}`);

    const notificationContacts = config.get('publishing.accountsPhoneNumbers');
    await Promise.all(notificationContacts.map((phoneNumber) => publisher.sendSms({ phoneNumber, message: `New Jupiter account opened. Human reference: ${userDetails.humanRef}` })));
};

const handleSaveInitiatedEvent = async (eventBody) => {
    logger('User initiated a save! Update their status');

    // user status update will also check, but this could get heavy, so might as well avoid it
    const userProfile = await fetchUserProfile(eventBody.userId);
    if (['CREATED', 'PASSWORD_SET', 'ACCOUNT_OPENED'].includes(userProfile.userStatus)) {
        // could parallel process these, but this is pretty significant if user is starting, and not at all otherwise
        const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_INITIATED_SAVE', reasonToLog: 'Saving event started' }};
        const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
        await lambda.invoke(statusInvocation).promise();
    }

    const { context } = eventBody;
    const { saveInformation } = context;

    if (saveInformation && saveInformation.paymentProvider && saveInformation.paymentProvider !== 'OZOW') {
        await sendEftInboundEmail(context);
    }
};

const handleSavingEvent = async (eventBody) => {
    logger('Saving event triggered!: ', eventBody);

    const promisesToInvoke = [];
        
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    promisesToInvoke.push(lambda.invoke(boostProcessInvocation).promise());
    
    if (emailSendingEnabled) {
        promisesToInvoke.push(sendSaveSucceededEmail(eventBody));
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

const obtainBankAccountDetails = async (userId) => {
    const key = `${config.get('cache.keyPrefixes.withdrawal')}::${userId}`;
    const cachedDetails = await redis.get(key);
    return JSON.parse(cachedDetails);
};

const handleWithdrawalEvent = async (eventBody) => {
    logger('Withdrawal event triggered! Event body: ', eventBody);

    const { userId, transactionId } = eventBody;
    const [userProfile, bankDetails] = await Promise.all([fetchUserProfile(userId, true), obtainBankAccountDetails(userId)]);

    bankDetails.accountHolder = `${userProfile.personalName} ${userProfile.familyName}`;
    
    await safeWithdrawalEmail(eventBody, userProfile, bankDetails);

    const processingPromises = [];
    const boostProcessInvocation = assembleBoostProcessInvocation(eventBody);
    processingPromises.push(lambda.invoke(boostProcessInvocation).promise());

    const accountId = eventBody.context.accountId;
    const [amount, unit, currency] = eventBody.context.withdrawalAmount.split('::');

    const bsheetOptions = { operation: 'WITHDRAW', accountId, amount: Math.abs(amount), unit, currency, bankDetails, transactionId };
    processingPromises.push(addInvestmentToBSheet(bsheetOptions));

    const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_WITHDRAWN', reasonToLog: 'User withdrew funds' }};
    const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
    logger('Status invocation: ', statusInvocation);
    processingPromises.push(lambda.invoke(statusInvocation).promise());

    await Promise.all(processingPromises);
};

// todo : write some tests
const handleWithdrawalCancelled = async (eventBody) => {
    logger('Withdrawal cancelled! Event body: ', eventBody);

    const { userId, context } = eventBody;
    const { transactionId, oldStatus, newStatus } = context;
    
    if (!transactionId) {
        logger('Malformed context, abort');
    }
   
    const [userProfile, transactionDetails] = await Promise.all([fetchUserProfile(userId), persistence.fetchTransaction(transactionId)]);
    
    if (newStatus !== 'CANCELLED' || transactionDetails.settlementStatus !== 'CANCELLED') {
        logger('Error! Event must have been published incorrectly');
    }

    // i.e., was not just user cancelling before the end
    if (oldStatus === 'PENDING') {
        await withdrawalCancelledEMail(userProfile, transactionDetails);
    }
};

const handleBoostRedeemedEvent = async (eventBody) => {
    logger('Handling boost redeemed event: ', eventBody);
    const { accountId, boostAmount } = eventBody.context;

    const bSheetReference = await persistence.fetchAccountTagByPrefix(accountId, config.get('defaults.balanceSheet.accountPrefix'));
    const [amount, unit, currency] = boostAmount.split('::');
    const wholeCurrencyAmount = parseInt(amount, 10) / UNIT_DIVISORS_TO_WHOLE[unit];

    const transactionDetails = { accountNumber: bSheetReference, amount: wholeCurrencyAmount, unit: 'WHOLE_CURRENCY', currency };
    const lambdaPayload = { operation: 'BOOST', transactionDetails };

    const investmentInvocation = invokeLambda(config.get('lambdas.addTxToBalanceSheet'), lambdaPayload);
    logger('Payload for balance sheet lambda: ', investmentInvocation);

    const bSheetResult = await lambda.invoke(investmentInvocation).promise();
    logger('Balance sheet result: ', bSheetResult);
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
            case 'USER_CREATED_ACCOUNT':
                await handleAccountOpenedEvent(eventBody);
                break;
            case 'SAVING_EVENT_INITIATED':
                await handleSaveInitiatedEvent(eventBody);
                break;
            case 'SAVING_PAYMENT_SUCCESSFUL':
                await handleSavingEvent(eventBody);
                break;
            case 'WITHDRAWAL_EVENT_CONFIRMED':
                await handleWithdrawalEvent(eventBody);
                break;
            case 'WITHDRAWAL_EVENT_CANCELLED':
                await handleWithdrawalCancelled(eventBody);
                break;
            case 'BOOST_REDEEMED':
                await handleBoostRedeemedEvent(eventBody);
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
