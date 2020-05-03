'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');

const validator = require('validator');
const randomWord = require('random-words');
const format = require('string-format');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');


const handleUserNotFound = async (friendRequest) => {
    const customerMessage = friendRequest.customerMessage ? friendRequest.customerMessage : null;
    friendRequest.customerMessage = customerMessage ? String(customerMessage.length) : 0;
    const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', insertionResult);

    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendRequest.initiatedUserId });
    const initiatedUserName = userProfile.calledName ? userProfile.calledName : userProfile.firstName;

    const { contactType, contactMethod } = friendRequest.targetContactDetails;

    let dispatchResult = null;

    if (contactType === 'PHONE') {
        const dispatchMsg = customerMessage
            ? customerMessage
            : format(config.get('templates.sms.friendRequest.template'), initiatedUserName);
        
        dispatchResult = await publisher.sendSms({ phoneNumber: contactMethod, message: dispatchMsg });
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult, dispatchResult }});
    }

    if (contactType === 'EMAIL') {
        const bodyTemplateKey = customerMessage
            ? config.get('templates.email.custom.templateKey')
            : config.get('templates.email.default.templateKey');

        const templateVariables = customerMessage ? { customerMessage } : { initiatedUserName };

        dispatchResult = await publisher.sendSystemEmail({
            subject: config.get('templates.email.default.subject'),
            toList: [contactMethod],
            bodyTemplateKey,
            templateVariables
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
 * @param {Object} event
 * @property {String} initiatedUserId Required. The user id of the user initiating the friendship. Defaults to the sytem id in the request header.
 * @property {String} targetUserId Required in the absence of targetContactDetails. The user id of the user whose friendship is being requested.
 * @property {String} targetContactDetails Required in the absence of targetUserId. Either the phone or email of the user whose friendship is being requested.
 * @property {Array } requestedShareItems Specifies what the initiating user wants to share. Valid values include ACTIVITY_LEVEL, ACTIVITY_COUNT, SAVE_VALUES, and BALANCE
 * @property {String} customerMessage An optional message that would be displayed when the friend request is viewed by the recieving user.
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

        if (friendRequest.customerMessage) {
            const blacklist = new RegExp(config.get('templates.blacklist'), 'u');
            if (blacklist.test(friendRequest.customerMessage)) {
                throw new Error(`Error: Invalid customer message`);
            }
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
 * @param {Object} event
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

/**
 * This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.
 * @param {Object} event
 * @property {String} requestId Required. The The friendships request id.
 * @property {Array} acceptedShareItems Specifies what the accepting user is willing to share from the array of requestedShareItems.
 */
module.exports.acceptFriendshipRequest = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const params = opsUtil.extractParamsFromEvent(event);
        const userDetails = opsUtil.extractUserDetails(event);

        const systemWideUserId = userDetails ? userDetails.systemWideUserId : params.systemWideUserId;
        const shareItems = params.acceptedShareItems ? params.acceptedShareItems : [];
        const requestId = params.requestId;

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
            const insertionResult = await persistenceWrite.insertFriendship(requestId, initiatedUserId, targetUserId, shareItems);
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
 * Proto-function intended to ignore a friend request recieved by a user. The difference between this function and the 
 * deactivateFriendship function is that this function ignores friendships that were never accepted.
 * @param {Object} event
 * @property {String} initiatedUserId The system id of the user to be ignored as a friend.
 */
module.exports.ignoreFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const targetUserId = userDetails.systemWideUserId;
        const { initiatedUserId } = opsUtil.extractParamsFromEvent(event);

        const resultOfIgnore = await persistenceWrite.ignoreFriendshipRequest(targetUserId, initiatedUserId);
        logger('Friendship update result:', resultOfIgnore);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { resultOfIgnore }});
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This functions deactivates a friendship.
 * @param {Object} event
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
