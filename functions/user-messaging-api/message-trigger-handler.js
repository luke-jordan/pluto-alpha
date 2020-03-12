'use strict';

const logger = require('debug')('jupiter:message:trigger');

const config = require('config');
const moment = require('moment');
const stringify = require('json-stable-stringify');

const rdsUtil = require('./persistence/rds.instructions');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const extractSnsMessage = async (snsEvent) => JSON.parse(snsEvent.Records[0].Sns.Message);

const statusToHalt = ['CREATED', 'SCHEDULED', 'READY_FOR_SENDING', 'SENDING'];

const createMsgInvocation = (instructionDestinationPairs) => ({
    FunctionName: config.get('lambdas.generateUserMessages'),
    InvocationType: 'Event',
    Payload: stringify({ instructions: instructionDestinationPairs })
});

const processInstructionForUser = (instruction, destinationUserId) => {
    const { instructionId, triggerParameters } = instruction;
    if (!triggerParameters || !triggerParameters.messageSchedule) {
        return { instructionId, destinationUserId };
    }

    const messageMoment = moment();
    const { type, offset, fixed } = triggerParameters.messageSchedule;
    
    if (type === 'RELATIVE') {
        messageMoment.add(offset.number, offset.unit);
        return { instructionId, destinationUserId, scheduledTimeEpochMillis: messageMoment.valueOf() };
    }

    if (type === 'FIXED') {
        messageMoment.add(offset.number, offset.unit).set({ hour: fixed.hour, minute: fixed.minute });
        return { instructionId, destinationUserId, scheduledTimeEpochMillis: messageMoment.valueOf() };
    }

    throw Error('Unsupported type of trigger schedule');
};

const disableMsgInvocation = (messageId) => ({
    FunctionName: config.get('lambdas.updateMessageStatus'),
    InvocationType: 'Event',
    Payload: stringify({ messageId, newStatus: 'SUPERCEDED' })
});


const findAndGenerateMessages = async (userId, eventType) => {
    const instructions = await rdsUtil.findMsgInstructionTriggeredByEvent(eventType);
    logger('Found instructions to generate, for event type: ', eventType, ' as: ', instructions);
    if (!instructions || instructions.length === 0) {
        logger('No instructions found to generate, exiting');
        return;
    }

    const messageCreationInstructions = instructions.map((instruction) => processInstructionForUser(instruction, userId));
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

/**
 * This function is triggered on user events. If the event is not in any black list and a message instruction
 * for the event exists, the instruction is processed and the resulting message is sent to the user.
 */
module.exports.createFromUserEvent = async (snsEvent) => {
    try {
        const eventBody = await extractSnsMessage(snsEvent);
        const { eventType, userId } = eventBody;

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

        await Promise.all([findAndGenerateMessages(userId, eventType), findAndHaltMessages(userId, eventType)]);

        return { statusCode: 200 };

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { statusCode: 500 };
    }
};
