'use strict';

const logger = require('debug')('jupiter:message:trigger');

const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const rdsUtil = require('./persistence/rds.instructions');
const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const statusToHalt = ['CREATED', 'SCHEDULED', 'READY_FOR_SENDING', 'SENDING'];

const createMsgInvocation = (instructionDestinationPairs) => ({
    FunctionName: config.get('lambdas.generateUserMessages'),
    InvocationType: 'Event',
    Payload: stringify({ instructions: instructionDestinationPairs })
});

const processInstructionForUser = (instruction, destinationUserId, context) => {
    const { instructionId, triggerParameters } = instruction;
    
    const basePayload = { instructionId, destinationUserId };
    if (context && context.messageParameters) {
        basePayload.parameters = context.messageParameters;
    }
    
    if (!triggerParameters || !triggerParameters.messageSchedule) {
        return basePayload;
    }

    const messageMoment = moment();
    const { type, offset, fixed } = triggerParameters.messageSchedule;
    
    if (type === 'RELATIVE') {
        messageMoment.add(offset.number, offset.unit);
        return { ...basePayload, scheduledTimeEpochMillis: messageMoment.valueOf() };
    }

    if (type === 'FIXED') {
        messageMoment.add(offset.number, offset.unit).set({ hour: fixed.hour, minute: fixed.minute });
        return { ...basePayload, scheduledTimeEpochMillis: messageMoment.valueOf() };
    }

    throw Error('Unsupported type of trigger schedule');
};

const disableMsgInvocation = (messageId) => ({
    FunctionName: config.get('lambdas.updateMessageStatus'),
    InvocationType: 'Event',
    Payload: stringify({ messageId, newStatus: 'SUPERCEDED' })
});


const findAndGenerateMessages = async (userId, eventType, context) => {
    const instructions = await rdsUtil.findMsgInstructionTriggeredByEvent(eventType);
    logger('Found instructions to generate, for event type: ', eventType, ' as: ', instructions);
    if (!instructions || instructions.length === 0) {
        logger('No instructions found to generate, exiting');
        return;
    }

    const messageCreationInstructions = instructions.map((instruction) => processInstructionForUser(instruction, userId, context));
    await lambda.invoke(createMsgInvocation(messageCreationInstructions)).promise();
};

const findAndHaltMessages = async (userId, eventType) => {
    const instructionIds = await rdsUtil.findMsgInstructionHaltedByEvent(eventType);
    logger('Found instructions Ids to halt, for event ', eventType, ' as: ', instructionIds);
    if (!instructionIds || instructionIds.length === 0) {
        logger('No instructions found to halt, exiting');
        return;
    }

    const msgIds = await rdsUtil.getMessageIdsForInstructions(instructionIds, userId, statusToHalt);
    logger('Message IDs found for the instructions: ', msgIds);

    const invocationPromises = msgIds.map((msgId) => lambda.invoke(disableMsgInvocation(msgId)).promise());
    const resultOfInstructions = await Promise.all(invocationPromises);
    logger('Result of issuing status processing: ', resultOfInstructions);
    return { result: 'SUCCESS' };
};

module.exports.createFromUserEvent = async (event) => {
    try {
        const { eventType, userId, context } = event;

        if (!userId) {
            throw Error('Event does not include a specific user ID');
        }

        const blackList = [
            ...config.get('security.defaultBlacklist'),
            ...config.get('security.additionalBlacklist')
        ];

        if (blackList.includes(eventType)) {
            return { statusCode: 200 };
        }

        await Promise.all([findAndGenerateMessages(userId, eventType, context), findAndHaltMessages(userId, eventType)]);

        return { statusCode: 200 };

    } catch (err) {
        // make sure to do this, otherwise, a single failure will fail the whole batch, which will be bad
        logger('FATAL_ERROR:', err);
        return { statusCode: 500 };
    }
};

/**
 * Triggered on user events. This function handles batch SQS user events. It parses the event from 
 * SQS then sends an array of parsed event objects to createFromUserMessage.
 */
module.exports.handleBatchUserEvents = async (sqsEvent) => {
    logger('Precise format of event: ', JSON.stringify(sqsEvent, null, 2));
    const snsEvents = opsUtil.extractSQSEvents(sqsEvent);
    logger('Extracted SNS events: ', snsEvents);
    const userEvents = snsEvents.map((snsEvent) => opsUtil.extractSNSEvent(snsEvent));
    return Promise.all(userEvents.map((event) => exports.createFromUserEvent(event)));
};
