'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');

const format = require('string-format');
const hri = require('human-readable-ids').hri;
const validator = require('validator');
const publisher = require('publish-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');
const opsUtil = require('ops-util-common');

/**
 * This functions accepts a users system id and returns the user's friends.
 * @param {object} event
 * @property {string} systemWideUserId Required. The user id of the user whose friends are to be extracted.
 */
module.exports.obtainFriends = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        
        let systemWideUserId = '';
        if (userDetails.role === 'SYSTEM_ADMIN') {
            const params = opsUtil.extractParamsFromEvent(event);
            systemWideUserId = params.systemWideUserId ? params.systemWideUserId : userDetails.systemWideUserId;
        } else {
            systemWideUserId = userDetails.systemWideUserId;
        }
    
        const userFriendIds = await persistenceRead.getFriendIdsForUser(systemWideUserId);
        logger('Got user ids:', userFriendIds);
    
        const profileRequests = userFriendIds.map((userId) => persistenceRead.fetchUserProfile({ systemWideUserId: userId }));
        const profilesForFriends = await Promise.all(profileRequests);
        logger('Got user profiles:', profilesForFriends);
    
        return opsUtil.wrapResponse(profilesForFriends);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

const handleUserNotFound = async (friendRequest, contactType) => {
    const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', insertionResult);

    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendRequest.initiatedUserId });
    const initiatedUserName = userProfile.calledName ? userProfile.calledName : userProfile.firstName;

    let dispatchResult = null;
    if (contactType === 'PHONE') {
        const phoneNumber = friendRequest.targetContactDetails;
        const dispatchMsg = format(config.get('sms.friendRequest.template'), initiatedUserName);
        dispatchResult = await publisher.sendSms({ phoneNumber, message: dispatchMsg });
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { dispatchResult }});
    }

    if (contactType === 'EMAIL') {
        dispatchResult = await publisher.sendSystemEmail({
            subject: config.get('email.friendRequest.subject'),
            toList: [friendRequest.targetContactDetails],
            bodyTemplateKey: config.get('email.friendRequest.templateKey'),
            templateVariables: { initiatedUserName }
        });
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { dispatchResult }});
    }
};

const generateRequestCode = async () => {
    const generatedCode = hri.random().split('-');
    const assembledRequestCode = `${generatedCode[0]} ${generatedCode[1]}`.toUpperCase();
    const isRequestCodeInUse = await persistenceRead.requesteCodeExists(assembledRequestCode);
    if (isRequestCodeInUse) {
        return generateRequestCode();
    }

    return assembledRequestCode;
};

const identifyContactType = (contact) => {
    if (validator.isEmail(contact)) {
        return 'EMAIL';
    }
    if (validator.isMobilePhone(contact, ['en-ZA'])) {
        return 'PHONE';
    }

    return null;
};

/**
 * This function persists a new friendship request.
 * @param {object} event
 * @property {string} initiatedUserId Required. The user id of the user initiating the friendship.
 * @property {string} targetUserId Required in the absence of targetContactDetails. The user id of the user whose friendship is being requested.
 * @property {string} targetContactDetails Required in the absence of targetUserId. Either the phone or email of the user whose friendship is being requested.
 */
module.exports.addFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;
    
        const friendRequest = opsUtil.extractParamsFromEvent(event);
        if (!friendRequest.targetUserId && !friendRequest.targetContactDetails) {
            throw new Error('Error! targetUserId or targetContactDetails must be provided');
        }

        friendRequest.initiatedUserId = systemWideUserId;

        if (!friendRequest.targetUserId) {
            const targetContactDetails = friendRequest.targetContactDetails;
            const contactType = identifyContactType(targetContactDetails);
            if (!contactType) {
                throw new Error(`Invalid target contact: ${targetContactDetails}`);
            }

            const targetUserForFriendship = await persistenceRead.fetchUserByContactDetail(targetContactDetails, contactType);
            if (!targetUserForFriendship) {
                friendRequest.requestCode = await generateRequestCode();
                return handleUserNotFound(friendRequest, contactType);
            }

            friendRequest.targetUserId = targetUserForFriendship.systemWideUserId;
        }
    
        const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
        logger('Result of friend request insertion:', insertionResult);
    
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult } });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.
 * @param {object} event
 * @property {string} requestId Required. The The friendships request id.
 */
module.exports.acceptFriendshipRequest = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = opsUtil.extractUserDetails(event);
        const { requestId } = opsUtil.extractParamsFromEvent(event);

        if (!requestId) {
            throw new Error('Error! Missing requestId');
        }

        const friendshipRequest = await persistenceRead.fetchFriendshipRequest(requestId);
        logger('Fetched friendship request:', friendshipRequest);
        if (!friendshipRequest) {
            throw new Error(`No friend request found for request id: ${requestId}`);
        }

        const { initiatedUserId, targetUserId } = friendshipRequest;
        if (targetUserId === systemWideUserId) {
            const insertionResult = await persistenceWrite.insertFriendship(initiatedUserId, systemWideUserId);
            logger('Result of friendship insertion:', insertionResult);
            return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult }});
        }
    
        throw new Error('Accepting user is not friendship target');
        
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This functions deactivates a friendship.
 * @param {object} event
 * @property {string} relationshipId The id of the relationship to be deactivated.
 */
module.exports.deactivateFriendship = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { relationshipId } = opsUtil.extractParamsFromEvent(event);
        if (!relationshipId) {
            throw new Error('Error! Missing relationshipId');
        }

        const deactivationResult = await persistenceWrite.deactivateFriendship(relationshipId);
        logger('Result of friendship deactivation:', deactivationResult);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { deactivationResult } });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};
