'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');

const validator = require('validator');
const format = require('string-format');
const randomWord = require('random-words');

const publisher = require('publish-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');
const opsUtil = require('ops-util-common');

/**
 * This functions accepts a users system id and returns the user's friends.
 * @param {object} event
 * @property {String} systemWideUserId Required. The system id of the user whose friends are to be extracted.
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

const handleUserNotFound = async (friendRequest) => {
    const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', insertionResult);

    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendRequest.initiatedUserId });
    const initiatedUserName = userProfile.calledName ? userProfile.calledName : userProfile.firstName;

    const { contactType, contactMethod } = friendRequest.targetContactDetails;

    let dispatchResult = null;
    if (contactType === 'PHONE') {
        const dispatchMsg = format(config.get('sms.friendRequest.template'), initiatedUserName);
        dispatchResult = await publisher.sendSms({ phoneNumber: contactMethod, message: dispatchMsg });
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult, dispatchResult }});
    }

    if (contactType === 'EMAIL') {
        dispatchResult = await publisher.sendSystemEmail({
            subject: config.get('email.friendRequest.subject'),
            toList: [contactMethod],
            bodyTemplateKey: config.get('email.friendRequest.templateKey'),
            templateVariables: { initiatedUserName }
        });

        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult, dispatchResult }});
    }
};

const generateRequestCode = async () => {
    const activeRequestCodes = await persistenceRead.fetchActiveRequestCodes();
    let assembledRequestCode = randomWord({ exactly: 2, join: ' ' }).toUpperCase();
    while (activeRequestCodes.includes(assembledRequestCode)) {
        assembledRequestCode = randomWord({ exactly: 2, join: ' ' }).toUpperCase();
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
 * @property {String} initiatedUserId Required. The user id of the user initiating the friendship. Defaults to the sytem id in the request header.
 * @property {String} targetUserId Required in the absence of targetContactDetails. The user id of the user whose friendship is being requested.
 * @property {String} targetContactDetails Required in the absence of targetUserId. Either the phone or email of the user whose friendship is being requested.
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

        if (friendRequest.targetContactDetails) {
            const contactMethod = friendRequest.targetContactDetails;
            const contactType = identifyContactType(contactMethod);
            if (!contactType) {
                throw new Error(`Error! Invalid target contact: ${contactMethod}`);
            }

            friendRequest.targetContactDetails = { contactType, contactMethod };
        }

        if (!friendRequest.targetUserId) {
            const targetContactDetails = friendRequest.targetContactDetails;
            const targetUserForFriendship = await persistenceRead.fetchUserByContactDetail(targetContactDetails);
            if (!targetUserForFriendship) {
                friendRequest.requestCode = await generateRequestCode();
                return handleUserNotFound(friendRequest);
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
 * This function completes a previously ambigious friend request, where a friend was requested using a contact detail not
 * associated with any system user id. This function is called once the target user has confirmed they are are indeed the target for the
 * friendship. It accepts a request code (to identify the request) and the target users system id. The friendship request is
 * sought and the user id is added to its targetUserId field.
 * @param {object} event
 * @param {String} systemWideUserId The target/accepting users system wide id
 * @param {String} requestCode The request code geneated during friend request creation. Used to find the persisted friend request.
 */
module.exports.connectFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;
        const { requestCode } = opsUtil.extractParamsFromEvent(event);

        const updateResult = await persistenceWrite.connectUserToFriendRequest(systemWideUserId, requestCode);
        if (updateResult.length === 0) {
            throw new Error(`Error! No friend request found for request code: ${requestCode}`);
        }

        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { updateResult }});
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

const appendUserNameToRequest = async (friendRequest) => {
    const systemWideUserId = friendRequest.initiatedUserId;
    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId });
    friendRequest.initiatedUserName = userProfile.calledName
        ? userProfile.calledName
        : userProfile.firstName;

    return friendRequest;
};

/**
 * This function returns an array of friend requests a user has not yet accepted (or rejected). Friend requests are
 * extracted for the system id in the request context.
 */
module.exports.findFriendRequestsForUser = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;

        // get friend requests
        const friendRequestsForUser = await persistenceRead.fetchFriendRequestsForUser(systemWideUserId);
        logger('Got requests:', friendRequestsForUser);
        if (friendRequestsForUser.length === 0) {
            return opsUtil.wrapResponse(friendRequestsForUser); 
        }

        // for each request append the user name of the initiating user
        const appendUserNames = friendRequestsForUser.map((request) => appendUserNameToRequest(request));
        const transformedRequests = await Promise.all(appendUserNames);
        logger('Transformed requests:', transformedRequests);

        return opsUtil.wrapResponse(transformedRequests);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.
 * @param {object} event
 * @property {String} requestId Required. The The friendships request id.
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

        const friendshipRequest = await persistenceRead.fetchFriendshipRequestById(requestId);
        logger('Fetched friendship request:', friendshipRequest);
        if (!friendshipRequest) {
            throw new Error(`Error! No friend request found for request id: ${requestId}`);
        }

        const { initiatedUserId, targetUserId } = friendshipRequest;
        if (targetUserId === systemWideUserId) {
            const insertionResult = await persistenceWrite.insertFriendship(requestId, initiatedUserId, targetUserId);
            logger('Result of friendship insertion:', insertionResult);
            return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult }});
        }
    
        throw new Error('Error! Accepting user is not friendship target');
        
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * Proto-function intended to reject a friend request recieved by a user. The difference between this function and the 
 * deactivateFriendship function is that this function rejects friendships that were never accepted.
 * @param {object} event
 * @property {String} initiatedUserId The system id of the user to be rejected as a friend.
 */
module.exports.rejectFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const targetUserId = userDetails.systemWideUserId;
        const { initiatedUserId } = opsUtil.extractParamsFromEvent(event);

        const rejectionResult = await persistenceWrite.rejectFriendshipRequest(targetUserId, initiatedUserId);
        logger('Friendship rejection result:', rejectionResult);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { rejectionResult }});
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This functions deactivates a friendship.
 * @param {object} event
 * @property {String} relationshipId The id of the relationship to be deactivated.
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
