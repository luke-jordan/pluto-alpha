'use strict';

const logger = require('debug')('jupiter:event:account');
const config = require('config');

const dispatchHelper = require('./dispatch-helper');

// note : we do not _accept_ the friendship requests because the user needs to decide on their sharing level
const findPendingFriendRequest = async (userProfile, lambda) => {
    try {
        const { systemWideUserId: targetUserId, emailAddress, phoneNumber, countryCode, referralCodeUsed } = userProfile;
        const referralSearchParams = { referralCodeUsed, countryCode, emailAddress, phoneNumber };

        const pendingInvocation = { targetUserId, ...referralSearchParams};
        const pendingFriendsInvocation = {
            FunctionName: config.get('lambdas.connectFriendReferral'), 
            InvocationType: 'Event',
            Payload: JSON.stringify(pendingInvocation)
        };
        
        logger('Referral friendship connect lambda args:', JSON.stringify(pendingFriendsInvocation));
        const pendingFriendsResult = await lambda.invoke(pendingFriendsInvocation).promise();
        logger('Result from lambda:', pendingFriendsResult);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
    }
};

const setupBsheetAccIfNone = async ({ userProfile, accountInfo, persistence, lambda }) => {
    const { tags } = accountInfo[0];
    logger('Fetched tags for account: ', tags);

    if (Array.isArray(tags) && tags.some((tag) => tag.startsWith(config.get('defaults.balanceSheet.accountPrefix')))) {
        logger('Already has FinWorks account');
        return;
    }

    const bsheetParams = { 
        idNumber: userProfile.nationalId, 
        surname: userProfile.familyName, 
        firstNames: userProfile.personalName, 
        humanRef: accountInfo[0].humanRef 
    };

    const accountCreationInvoke = {
        FunctionName: config.get('lambdas.createBalanceSheetAccount'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(bsheetParams)
    };

    const rawLambdaResult = await lambda.invoke(accountCreationInvoke).promise();
    logger('Result of FinWorks account creation:', rawLambdaResult);

    const bsheetAccountResult = JSON.parse(rawLambdaResult['Payload']);

    if (typeof bsheetAccountResult !== 'object' || !Object.keys(bsheetAccountResult).includes('accountNumber')) {
        throw new Error(`Error creating user FinWorks account: ${bsheetAccountResult}`);
    }

    logger('Finworks account creation resulted in:', bsheetAccountResult);

    const tag = `${config.get('defaults.balanceSheet.accountPrefix')}::${bsheetAccountResult.accountNumber}`;
    const accountUpdateResult = await persistence.updateAccountTags(userProfile.systemWideUserId, tag);
    
    logger('Updating account tags resulted in:', accountUpdateResult);
};

module.exports.handleAccountOpenedEvent = async ({ eventBody, userProfile, persistence, publisher, lambda }) => {
    logger('Handling event:', eventBody, ' with profile: ', userProfile);
    const { userId } = eventBody;
    const accountInfo = await persistence.findHumanRefForUser(userId);
    logger('Result of account info retrieval: ', accountInfo);
    const userDetails = { idNumber: userProfile.nationalId, surname: userProfile.familyName, firstNames: userProfile.personalName };
    if (Array.isArray(accountInfo) && accountInfo.length > 0) {
        userDetails.humanRef = accountInfo[0].humanRef;
    }
    
    if (userProfile.kycStatus === 'VERIFIED_AS_PERSON') {
        logger('User is KYC verified, create ground-truth account if none already');
        await setupBsheetAccIfNone({ userProfile, accountInfo, persistence, lambda });
    }

    const notificationContacts = config.get('publishing.accountsPhoneNumbers');
    const finalProcesses = notificationContacts.map((phoneNumber) => publisher.sendSms({ phoneNumber, message: `New Jupiter account opened. Human reference: ${userDetails.humanRef}` }));

    finalProcesses.push(findPendingFriendRequest(userProfile, lambda));

    const boostEvent = { ...eventBody, context: { accountId: accountInfo[0].accountId }};
    const boostProcessInvocation = dispatchHelper.assembleBoostProcessInvocation(boostEvent);
    finalProcesses.push(lambda.invoke(boostProcessInvocation).promise());

    await Promise.all(finalProcesses);
};

module.exports.handleKyCompletedEvent = async ({ eventBody, userProfile, persistence, lambda }) => {
    const { userId } = eventBody;
    logger('Handling KYC completed event: ', eventBody);

    const accountInfo = await persistence.findHumanRefForUser(userId);
    if (!Array.isArray(accountInfo) || accountInfo.length === 0) {
        logger('Account not opened yet, let account open handle');
        return;
    }

    await setupBsheetAccIfNone({ userProfile, accountInfo, persistence, lambda });
};
