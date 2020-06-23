'use strict';

const logger = require('debug')('jupiter:event:friend');
const config = require('config');

// injection would be probably better in here, but leaving for next round of refactor
module.exports.handleFriendshipConnectedEvent = async ({ eventBody, persistence, lambda }) => {
    // for the moment all we do is assemble friend list and pass to boost processing
    const { userId, eventType } = eventBody;
    const currentFriendsList = await persistence.getMinimalFriendListForUser(userId);
    const friendshipList = currentFriendsList.map(({ relationshipId, initiatedUserId, creationTime }) => ({ 
        relationshipId, 
        creationTimeMillis: creationTime.valueOf(),
        userInitiated: userId === initiatedUserId
    }));
    const boostPayload = { userId, eventType, eventContext: { friendshipList }};
    const boostInvocation = {
        FunctionName: config.get('publishing.processingLambdas.boosts'),
        InvocationType: 'Event',
        Payload: JSON.stringify(boostPayload)
    };
    logger('Invoking boost process with: ', JSON.stringify(boostInvocation, null, 2));
    await lambda.invoke(boostInvocation).promise();
};
