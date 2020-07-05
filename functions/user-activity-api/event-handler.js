'use strict';

// NOTE: this is a queue worker, in effect. It subscribes to the pub topic for user events,
// and directs them to other lambdas and/or (in time) SQS queues and the like

const logger = require('debug')('jupiter:event-handling:main');
const config = require('config');
const opsUtil = require('ops-util-common');

// primary dependencies for persistence and cache
const persistence = require('./persistence/rds');
const Redis = require('ioredis');
const redis = new Redis({ port: config.get('cache.port'), host: config.get('cache.host') });

// for dispatching the mails & DLQ & invoking other lambdas
const publisher = require('publish-common');
const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const sns = new AWS.SNS();
const lambda = new AWS.Lambda();

// these do the heavy lifting; dividing as complexity was overwhelming this handler
const accountEventHandler = require('./event/account-event-handler');
const boostEventHandler = require('./event/boost-redeemed-event-handler');
const friendEventHandler = require('./event/friend-event-handler');
const saveEventHandler = require('./event/save-event-handler');
const withdrawEventHandler = require('./event/withdrawal-event-handler');

// for unwrapping some AWS stuff
const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const extractSnsMessageId = (snsMessage) => snsMessage.MessageId;

const invokeProfileLambda = async (systemWideUserId, includeContactMethod) => {
    const profileFetchLambdaInvoke = {
        FunctionName: config.get('lambdas.fetchProfile'), 
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ systemWideUserId, includeContactMethod })
    };

    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    const profileResult = extractLambdaBody(profileFetchResult);
    
    const cacheTtl = config.get('cache.ttls.profile');
    const keyPrefix = config.get('cache.keyPrefixes.profile');
    await redis.set(`${keyPrefix}::${systemWideUserId}`, JSON.stringify(profileResult), 'EX', cacheTtl);
    return profileResult;
};

const fetchUserProfile = async (systemWideUserId, includePrimaryContact) => {
    const requiresContactScan = typeof includePrimaryContact === 'boolean' && includePrimaryContact;
    
    logger(`Fetching profile in event process, passed includePrimaryContact: ${includePrimaryContact} and sending on: ${requiresContactScan}`);
    const cachedProfile = await redis.get(`${config.get('cache.keyPrefixes.profile')}::${systemWideUserId}`);
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

const EVENT_DISPATCHER = {
    USER_CREATED_ACCOUNT: accountEventHandler.handleAccountOpenedEvent,
    VERIFIED_AS_PERSON: accountEventHandler.handleKyCompletedEvent,
    SAVING_EVENT_INITIATED: saveEventHandler.handleSaveInitiatedEvent,
    SAVING_PAYMENT_SUCCESSFUL: saveEventHandler.handleSavingEvent,
    WITHDRAWAL_EVENT_CONFIRMED: withdrawEventHandler.handleWithdrawalEvent,
    WITHDRAWAL_EVENT_CANCELLED: withdrawEventHandler.handleWithdrawalCancelled,
    BOOST_REDEEMED: boostEventHandler.handleBoostRedeemedEvent,
    FRIEND_REQUEST_TARGET_ACCEPTED: friendEventHandler.handleFriendshipConnectedEvent,
    FRIEND_REQUEST_INITIATED_ACCEPTED: friendEventHandler.handleFriendshipConnectedEvent
};

const EVENT_REQUIRES_CONTACT = {
    USER_CREATED_ACCOUNT: { requiresProfile: true, requiresContact: true },
    VERIFIED_AS_PERSON: { requiresProfile: true, requiresContact: true },
    SAVING_EVENT_INITIATED: { requiresProfile: true, requiresContact: false },
    SAVING_PAYMENT_SUCCESSFUL: { requiresProfile: false },
    WITHDRAWAL_EVENT_CONFIRMED: { requiresProfile: true, requiresContact: true },
    WITHDRAWAL_EVENT_CANCELLED: { requiresProfile: true, requiresContact: false },
    BOOST_REDEEMED: { requiresProfile: false },
    FRIEND_REQUEST_TARGET_ACCEPTED: { requiresProfile: false },
    FRIEND_REQUEST_INITIATED_ACCEPTED: { requiresProfile: false }
};

/**
 * This function handles successful account opening, saving, and withdrawal events. It is typically called by SNS. The following properties are expected in the SNS message:
 * @param {object} eventBody An event object containing our parameter(s) of interest
 * @property {string} eventType The type of event to be processed. Valid values are SAVING_PAYMENT_SUCCESSFUL, WITHDRAWAL_EVENT_CONFIRMED, and PASSWORD_SET (for opened accounts).
 */
module.exports.handleUserEvent = async (eventBody) => {
    try {
        const { userId, eventType } = eventBody;
        if (!Reflect.has(EVENT_DISPATCHER, eventType)) {
            logger(`We don't handle ${eventType}, let it pass`);
            return { statusCode: 200 };
        }

        let userProfile = {};
        if (EVENT_REQUIRES_CONTACT[eventType].requiresProfile) {
            userProfile = await fetchUserProfile(userId, EVENT_REQUIRES_CONTACT[eventType].requiresContact);
        }

        // as noted in the individual modules, singleton-injection will come at some point, and this is a little inelegant,
        // but it means a single Lambda container will only have one of each and will handle all events 

        await EVENT_DISPATCHER[eventType]({ eventBody, userProfile, persistence, publisher, lambda, sns, redis });

        return { statusCode: 200 };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        await publisher.addToDlq(config.get('queues.eventDlq'), eventBody, err);
        return { statusCode: 500 };
    }
};

/**
 * This function processes a batch of events from SQS
 * @param {object} sqsEvent As usual for AWS, wrapped in half a dozen layers, but includes events of interest
 */
module.exports.handleBatchOfQueuedEvents = async (sqsEvent) => {
    const snsEvents = opsUtil.extractSQSEvents(sqsEvent);
    logger('Extracted SNS events: ', snsEvents);

    // for tracing this slippery duplicate boost redemption event
    snsEvents.forEach((snsEvent) => logger(`SNS_EVENT_HANDLING:: Handling event with message ID: SNS_MESSAGE_ID::${extractSnsMessageId(snsEvent)}`));

    const userEvents = snsEvents.map((snsEvent) => opsUtil.extractSNSEvent(snsEvent));
    // failures happen inside individual event handling to avoid errors on one causing retries of all 
    return Promise.all(userEvents.map((event) => exports.handleUserEvent(event)));
};
