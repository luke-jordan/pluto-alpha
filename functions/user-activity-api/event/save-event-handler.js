'use strict';

const logger = require('debug')('jupiter:event:save');
const config = require('config');

const opsUtil = require('ops-util-common');
const dispatchHelper = require('./dispatch-helper');

const emailSendingEnabled = config.get('publishing.eventsEmailEnabled');

// ///////////////////////// EMAIL HANDLING ////////////////////////////////////////////////////////////

const profileLink = (bankReference) => {
    const profileSearch = `users?searchValue=${encodeURIComponent(bankReference)}&searchType=bankReference`;
    return `${config.get('publishing.adminSiteUrl')}/#/${profileSearch}`;
};

const sendEftInboundEmail = async (eventContext, publisher) => {
    const { saveInformation, initiationResult } = eventContext;

    const templateVariables = { 
        savedAmount: opsUtil.formatAmountCurrency(saveInformation, 2), 
        bankReference: initiationResult.humanReference,
        profileLink: profileLink(initiationResult.humanReference)
    };

    const emailParams = {
        toList: config.get('publishing.saveEmailDestination'),
        subject: 'EFT transfer initiated',
        bodyTemplateKey: config.get('templates.eftEmail'),
        templateVariables
    };
    
    return publisher.sendSystemEmail(emailParams);
};

const sendSaveSucceededEmail = async (eventBody, publisher) => {
    const { context: saveContext } = eventBody;
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
        savedAmount: opsUtil.extractAndFormatAmountString(saveContext.savedAmount, 2),
        saveCountText: countText,
        bankReference: saveContext.bankReference,
        profileLink: profileLink(saveContext.bankReference)    
    };

    const emailParams = {
        toList: config.get('publishing.saveEmailDestination'),
        subject: 'Yippie kay-yay',
        bodyTemplateKey: config.get('templates.saveEmail'),
        templateVariables
    }
        
    logger('Assembled email parameters: ', emailParams);
    const emailResult = await publisher.sendSystemEmail(emailParams);
    logger('And email result: ', emailResult);
    return emailResult;
};

// ///////////////////////// EVENT DISPATCHING ////////////////////////////////////////////////////////////

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

// ///////////////////////// CORE DISPATCHERS //////////////////////////////////////////////////////////

module.exports.handleSaveInitiatedEvent = async ({ eventBody, userProfile, lambda, publisher }) => {
    logger('User initiated a save! Update their status');

    if (['CREATED', 'PASSWORD_SET', 'ACCOUNT_OPENED'].includes(userProfile.userStatus)) {
        // could parallel process these, but this is pretty significant if user is starting, and not at all otherwise
        const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_INITIATED_SAVE', reasonToLog: 'Saving event started' }};
        const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
        await lambda.invoke(statusInvocation).promise();
    }

    const { context } = eventBody;
    const { saveInformation } = context;

    if (saveInformation && saveInformation.paymentProvider && saveInformation.paymentProvider !== 'OZOW') {
        await sendEftInboundEmail(context, publisher);
    }
};

module.exports.handleSavingEvent = async ({ eventBody, persistence, publisher, lambda }) => {
    logger('Saving event triggered!: ', eventBody);

    const promisesToInvoke = [];
        
    const boostProcessInvocation = dispatchHelper.assembleBoostProcessInvocation(eventBody);
    promisesToInvoke.push(lambda.invoke(boostProcessInvocation).promise());
    
    if (emailSendingEnabled) {
        promisesToInvoke.push(sendSaveSucceededEmail(eventBody, publisher));
    }

    const { context } = eventBody;
    const { accountId, transactionId, savedAmount } = context;

    const statusInstruction = { updatedUserStatus: { changeTo: 'USER_HAS_SAVED', reasonToLog: 'Saving event completed' }};
    const statusInvocation = assembleStatusUpdateInvocation(eventBody.userId, statusInstruction);
    promisesToInvoke.push(lambda.invoke(statusInvocation).promise());
    
    const [amount, unit, currency] = savedAmount.split('::');
    const bsheetParams = { accountId, transactionId, amount, unit, currency };
    const bsheetPromise = dispatchHelper.addInvestmentToBSheet({ operation: 'INVEST', parameters: bsheetParams, persistence, lambda });
    promisesToInvoke.push(bsheetPromise);

    // removing this for now -- not sure allowing this to publish is wise, and have other/better ways to trigger
    // we sometimes have boosts and other events attached to this (could use 'firstSave', but this feels less fragile, and
    // in time we might in fact just count it directly, if we see attempted spoofing etc) // and for now, removing in fact
    // if (saveCount === 1) {
    //     logger('Firt user save, so trigger game for them');
    //     promisesToInvoke.push(publisher.publishUserEvent(eventBody.userId, 'USER_COMPLETED_FIRST_SAVE', { context }));
    // }

    await Promise.all(promisesToInvoke);
};
