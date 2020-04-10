'use strict';

const logger = require('debug')('jupiter:friends:main');

const persistence = require('./persistence/get-profiles');
const profileHandler = require('./persistence/handle-profiles');
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
    
        const userFriendIds = await persistence.getFriendIdsForUser(systemWideUserId);
        logger('Got user ids:', userFriendIds);
    
        const profileRequests = userFriendIds.map((userId) => persistence.fetchUserProfile({ systemWideUserId: userId }));
        const profilesForFriends = await Promise.all(profileRequests);
        logger('Got user profiles:', profilesForFriends);
    
        return opsUtil.wrapResponse(profilesForFriends);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This function persists a new friendship request.
 * @param {object} event
 * @property {string} initiatedUserId Required. The user id of the user initiating the friendship.
 * @property {string} targetUserId Required in the absence of targetContactDetails. The user id of the user whose friendship is being requested.
 * @property {string} targetContactDetails Required in the absence of targetUserId. Either the phone or email of the user whose friendship is being requested.
 */
module.exports.addFriendRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;
    
        const params = opsUtil.extractParamsFromEvent(event);
        if (!params.targetUserId && !params.targetContactDetails) {
            throw new Error('Error! targetUserId or targetContactDetails must be provided');
        }
    
        const friendRequestParams = { initiatedUserId: systemWideUserId, ...params };
        const resultOfInsertion = await profileHandler.insertFriendRequest(friendRequestParams);
        logger('Result of friend request insertion:', resultOfInsertion);
    
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.
 * @param {object} event
 * @property {string} initiatedUserId Required. The user id of the user who initiated the friendship.
 * @property {string} acceptedUserId Required. The user id of the user who accepted the friendship.
 */
module.exports.addFriendship = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { initiatedUserId, acceptedUserId } = opsUtil.extractParamsFromEvent(event);
        if (!initiatedUserId || !acceptedUserId) {
            throw new Error('Error! Missing initiatedUserId or acceptedUserId');
        }
    
        const resultOfInsertion = await profileHandler.insertFriendship(initiatedUserId, acceptedUserId);
        logger('Result of friendship insertion:', resultOfInsertion);
    
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This functions deactivates a friendhip.
 * @param {object} event
 * @property {string} relationshipId The id of the relationship to be deactivated.
 */
module.exports.removeFriendship = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { relationshipId } = opsUtil.extractParamsFromEvent(event);
        if (!relationshipId) {
            throw new Error('Error! Missing relationshipId');
        }

        const resultOfRemoval = await profileHandler.deactivateFriendship(relationshipId);
        logger('Result of friendship removal:', resultOfRemoval);

        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};
