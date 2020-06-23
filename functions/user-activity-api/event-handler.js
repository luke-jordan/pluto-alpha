'use strict';

// NOTE: this is a queue worker, in effect. It subscribes to the pub topic for user events,
// and directs them to other lambdas and/or (in time) SQS queues and the like

const logger = require('debug')('jupiter:event-handling:main');
const config = require('config');


// primary dependencies for persistence and cache
const persistence = require('./persistence/rds');
const Redis = require('ioredis');
const redis = new Redis({ port: config.get('cache.port'), host: config.get('cache.host') });

// for dispatching the mails & DLQ & invoking other lambdas
const publisher = require('publish-common');
const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const sqs = new AWS.SQS();
const sns = new AWS.SNS();
const lambda = new AWS.Lambda();

// these do the heavy lifting; dividing as complexity was overwhelming this handler
const accountEventHandler = require('./event/account-event-handler');
const boostEventHandler = require('./event/boost-event-handler');
const friendEventHandler = require('./event/friend-event-handler');
const saveEventHandler = require('./event/save-event-handler');
const withdrawEventHandler = require('./event/withdrawal-event-handler');

// for unwrapping some AWS stuff
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
    FRIEND_REQUEST_INITIATED_ACCEPTED: friendEventHandler.handleFriendshipConnectedEvent,
}

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
 * @param {object} snsEvent An SNS event object containing our parameter(s) of interest in its Message property.
 * @property {string} eventType The type of event to be processed. Valid values are SAVING_PAYMENT_SUCCESSFUL, WITHDRAWAL_EVENT_CONFIRMED, and PASSWORD_SET (for opened accounts).
 */
module.exports.handleUserEvent = async (snsEvent) => {
    try {
        const eventBody = await extractSnsMessage(snsEvent);
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

        await EVENT_DISPATCHER[eventType]({ eventBody, userProfile, persistence, publisher, lambda, sqs, sns, redis });

        return { statusCode: 200 };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        await addToDlq(snsEvent, err);
        return { statusCode: 500 };
    }
};
