'use strict';

const logger = require('debug')('jupiter:friends:main');
const validator = require('validator');
const hri = require('human-readable-ids').hri;

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

const handleSMSConfirmation = async (friendRequest) => {
    const smsTemplate = {}; // get template
    // send sms, throw error on failure
    return { result: 'SUCCESS' };
};

const handleEmailConfirmation = async (friendRequest) => {
    const emailTemplate = {}; // get template
    // send email, throw error on failure
    return { result: 'SUCCESS' };
};

const generateRequestCode = () => {
    const generatedCode = hri.random().split('-');
    // todo: validate request code is not used in any active requests
    return `${generatedCode[0]}_${genaratedCode[1]}`.toUpperCase();
}

const identifyContactType = (contact) => {
    if (validator.isEmail(contact)) {
        return 'EMAIL';
    }
    if (validator.isMobilePhone(contact, ['en-ZA'])) {
        return 'PHONE';
    }

    return null;
};

const handleUserNotFound = async (friendRequest, contactType) => {
    const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', insertionResult);
    // validate response from persistence

    if (contactType === 'PHONE') {
        return handleSMSConfirmation(friendRequest);
    }

    if (contactType === 'EMAIL') {
        return handleEmailConfirmation(friendRequest);
    }
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
                friendRequest.requestCode = generateRequestCode();
                return handleUserNotFound(friendRequest, contactType);
            }

            friendRequest.targetUserId = targetUserForFriendship.systemWideUserId;
        }
    
        const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
        logger('Result of friend request insertion:', insertionResult);
    
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
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
            const resultOfInsertion = await persistenceWrite.insertFriendship(initiatedUserId, systemWideUserId);
            logger('Result of friendship insertion:', resultOfInsertion);
            return opsUtil.wrapResponse({ result: 'SUCCESS' });
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

        const resultOfRemoval = await persistenceWrite.deactivateFriendship(relationshipId);
        logger('Result of friendship removal:', resultOfRemoval);

        // log event
        // return result from db in final response
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};
