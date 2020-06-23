'use strict';

const logger = require('debug')('jupiter:withdrawal:event');
const config = require('config');

const util = require('ops-util-common');
const dispatchHelper = require('./dispatch-helper');

// ///////////////////////// EMAIL HANDLING ////////////////////////////////////////////////////////////

// handling withdrawals by sending email
const safeWithdrawalEmail = async ({ eventBody, userProfile, bankAccountDetails, publisher, sns }) => {
    const withdrawalAmount = util.extractAndFormatAmountString(eventBody.context.withdrawalAmount, 2);
    const contactMethod = userProfile.emailAddress || userProfile.phoneNumber;
    const profileLink = `${config.get('publishing.adminSiteUrl')}/#/users?` +
        `searchValue=${encodeURIComponent(contactMethod)}&searchType=phoneOrEmail`;
    
    const templateVariables = {
        withdrawalAmount,
        contactMethod,
        profileLink,
        ...bankAccountDetails,
    }

    const emailParams = {
        toList: config.get('publishing.withdrawalEmailDestination'),
        subject: 'User wants to withdraw',
        bodyTemplateKey: config.get('templates.withdrawalEmail'),
        templateVariables,
        invokeSync: true // important that errors are reported immediately
    };
    
    try {
        const emailResult = await publisher.sendSystemEmail(emailParams);
        logger('Result of sending email: ', emailResult);
        
        if (emailResult.result === 'SUCCESS') {
            logger('Email sent successfully');
            return;
        };

        throw Error('Withdrawal email failed, check logs');
    } catch (err) {
        // we want the rest to execute, so we manually publish to the dlq, and alert admins
        logger('FATAL_ERROR: ', err);

        const snsMessage = {
            Message: `Jupiter Withdrawal! Withdrawal triggered for ${contactMethod}, but failed on email dispatch.`,
            MessageStructure: 'string',
            TopicArn: config.get('publishing.userEvents.withdrawalTopic')
        };

        logger('Sending parameters to message: ', snsMessage);
        const resultOfSns = await sns.publish(snsMessage).promise();
        logger('Result of SNS dispatch: ', resultOfSns);

        addToDlq({ eventType: 'WITHDRAWAL', eventBody, templateVariables });
    }
};

// this will be rare so just do a simple one
const withdrawalCancelledEMail = async (userProfile, transactionDetails) => {
    const userName = `${userProfile.personalName} ${userProfile.familyName}`;
    const htmlBody = `<p>Hello,</p><p>Good news! ${userName} has decided to cancel their withdrawal. This was sent with ` +
        `bank reference, ${transactionDetails.humanReference}. Please abort the withdrawal!</p><p>The Jupiter System</p>`;
    const textBody = `${userName} cancelled their withdrawal`;
    
    const emailParams = {
        from: config.get('publishing.eventsEmailAddress'),
        toAddresses: config.get('publishing.withdrawalEmailDestination'),
        subject: 'Jupiter withdrawal cancelled', 
        htmlBody, textBody
    };
    
    const emailResult = await publisher.safeEmailSendPlain(emailParams);
    logger('Result of sending email: ', emailResult);
};

// ///////////////////////// CORE DISPATCHERS //////////////////////////////////////////////////////////

module.exports.handleWithdrawalEvent = async ({ eventBody, userProfile, publisher, persistence, lambda, sns, redis }) => {
    logger('Withdrawal event triggered! Event body: ', eventBody);

    const { userId, transactionId } = eventBody;
    const cachedDetails = await redis.get(`${config.get('cache.keyPrefixes.withdrawal')}::${userId}`);
    const bankDetails = JSON.parse(cachedDetails);

    bankDetails.accountHolder = `${userProfile.personalName} ${userProfile.familyName}`;
    
    await safeWithdrawalEmail({ eventBody, userProfile, bankDetails, publisher, sns });

    const processingPromises = [];
    const boostProcessInvocation = dispatchHelper.assembleBoostProcessInvocation(eventBody);
    processingPromises.push(lambda.invoke(boostProcessInvocation).promise());

    const accountId = eventBody.context.accountId;
    const [amount, unit, currency] = eventBody.context.withdrawalAmount.split('::');

    const bsheetParams = { accountId, amount: Math.abs(amount), unit, currency, bankDetails, transactionId };
    const bsheetPromise = dispatchHelper.addInvestmentToBSheet({ operation: 'WITHDRAW', parameters: bsheetParams, persistence, lambda });
    processingPromises.push(bsheetPromise);

    const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_WITHDRAWN', reasonToLog: 'User withdrew funds' }};
    const statusInvocation = {
        FunctionName: config.get('publishing.processingLambdas.status'),
        InvocationType: 'Event',
        Payload: JSON.stringify({ systemWideUserId: userId, ...statusInstruction })
    };
    
    logger('Status invocation: ', statusInvocation);
    processingPromises.push(lambda.invoke(statusInvocation).promise());

    await Promise.all(processingPromises);
};

// todo : write some tests
module.exports.handleWithdrawalCancelled = async ({ eventBody, userProfile }) => {
    logger('Withdrawal cancelled! Event body: ', eventBody);

    const { userId, context } = eventBody;
    const { transactionId, oldStatus, newStatus } = context;
    
    if (!transactionId) {
        logger('Malformed context, abort');
    }
   
    const transactionDetails = await persistence.fetchTransaction(transactionId);
    
    if (newStatus !== 'CANCELLED' || transactionDetails.settlementStatus !== 'CANCELLED') {
        logger('Error! Event must have been published incorrectly');
    }

    // i.e., was not just user cancelling before the end
    if (oldStatus === 'PENDING') {
        await withdrawalCancelledEMail(userProfile, transactionDetails);
    }
};
