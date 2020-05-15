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

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const ALLOWED_USER_STATUS = ['USER_HAS_SAVED', 'USER_HAS_WITHDRAWN'];

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const invokeSavingHeatLambda = async (accountIds) => {
    const includeLastActivityOfType = config.get('share.activities');
    const savingHeatLambdaInvoke = invokeLambda(config.get('lambdas.calcSavingHeat'), { accountIds, includeLastActivityOfType });
    logger('Invoke savings heat lambda with arguments: ', savingHeatLambdaInvoke);
    const savingHeatResult = await lambda.invoke(savingHeatLambdaInvoke).promise();
    logger('Result of savings heat calculation: ', savingHeatResult);
    const heatPayload = JSON.parse(savingHeatResult.Payload);
    const { details } = heatPayload;
    return details;
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
    if (validator.isEmail(contact.trim())) {
        return 'EMAIL';
    }
    
    if (validator.isMobilePhone(contact.trim(), ['en-ZA'])) {
        return 'PHONE';
    }

    return null;
};

const extractValidateFormatContact = (phoneOrEmail) => {
    if (!phoneOrEmail) {
        return { contactType: 'INVALID' };
    }
    
    let contactMethod = phoneOrEmail.replace(/\s/g,'').toLowerCase();
    const contactType = identifyContactType(contactMethod);
    
    if (!contactType) {
        // so we pick up frequency in here
        logger(`FATAL_ERROR: Invalid target contact: ${phoneOrEmail}`);
        return { contactType: 'INVALID' };
    }
    
    if (contactType === 'PHONE') {
        contactMethod = contactMethod.replace(/^0/,'27'); // todo : apply simple formatting
    }

    return { contactType, contactMethod };
};

const checkForUserWithContact = async (contactDetails) => {
    if (!contactDetails.contactMethod) {
        return null;
    }
    
    const lookUpPayload = { phoneOrEmail: contactDetails.contactMethod, countryCode: 'ZAF' };
    const lookUpInvoke = invokeLambda(config.get('lambdas.lookupByContactDetails'), lookUpPayload);
    const systemWideIdResult = await lambda.invoke(lookUpInvoke).promise();
    const systemIdPayload = JSON.parse(systemWideIdResult['Payload']);

    if (systemIdPayload.statusCode !== 200) {
        return null;
    }

    return JSON.parse(systemIdPayload.body);
};

// simple method to determine if a contact method has a user aligned
// todo : cache the number of requests to this by a user and after 5 in one minute just return not found 
module.exports.seekFriend = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        
        const { phoneOrEmail } = opsUtil.extractParamsFromEvent(event);
        const contactDetails = extractValidateFormatContact(phoneOrEmail);
        if (contactDetails.contactType === 'INVALID') {
            return { statusCode: 400, body: 'Invalid contact detail' };
        }

        const userResult = await checkForUserWithContact(contactDetails);
        if (!userResult) {
            return { statusCode: 404 };
        }
        
        const { systemWideUserId } = userResult;
        const { personalName, calledName, familyName} = await persistenceRead.fetchUserProfile({ systemWideUserId });
        
        const targetUserName = `${calledName || personalName} ${familyName}`;
        return { statusCode: 200, body: JSON.stringify({ systemWideUserId, targetUserName })};
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 404 };
    }
};

const fetchAndExtractReferralDetails = async (referralPayload) => {
    const referralInvocation = invokeLambda(config.get('lambdas.referralDetails'), referralPayload, true);
        
    const bundledResponse = await lambda.invoke(referralInvocation).promise();
    const extractedPayload = JSON.parse(bundledResponse.Payload);
    const { result, codeDetails } = JSON.parse(extractedPayload.body);
    logger('Code fetch result: ', result);
    return { result, codeDetails };
};

// and another one, to get current referral data
module.exports.obtainReferralCode = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }
        
        const { systemWideUserId } = userDetails;
        const { referralCode, countryCode } = await persistenceRead.fetchUserProfile({ systemWideUserId });
        const referralPayload = { referralCode, countryCode, includeFloatDefaults: true };
        const { codeDetails } = await fetchAndExtractReferralDetails(referralPayload);
        return opsUtil.wrapResponse(codeDetails);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
};

const appendUserNameToRequest = async (userId, friendRequest) => {
    const type = friendRequest.targetUserId === userId ? 'RECEIVED' : 'INITIATED';
    const friendUserId = type === 'INITIATED' 
        ? friendRequest.targetUserId
        : friendRequest.initiatedUserId;

    const transformedResult = {
        type,
        requestId: friendRequest.requestId,
        requestedShareItems: friendRequest.requestedShareItems,
        creationTime: friendRequest.creationTime
    };

    if (type === 'INITIATED') {
        if (friendRequest.targetContactDetails) {
            transformedResult.contactMethod = friendRequest.targetContactDetails.contactMethod;
        }
    }
    
    if (!friendUserId) {
        // means it was an invite to a non-user
        return transformedResult;
    }

    const profile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendUserId });
    logger('Got friend profile:', profile);

    transformedResult.personalName = profile.personalName;
    transformedResult.familyName = profile.familyName;
    transformedResult.calledName = profile.calledName ? profile.calledName : profile.personalName;

    if (type === 'RECEIVED') {
        const mutualFriendCount = await persistenceRead.countMutualFriends(userId, [friendUserId]);
        transformedResult.numberOfMutualFriends = mutualFriendCount[0][friendUserId];
    }

    if (friendRequest.customShareMessage) {
        transformedResult.customShareMessage = friendRequest.customShareMessage;
    }

    if (friendRequest.requestCode) {
        transformedResult.requestCode = friendRequest.requestCode;
    }

    logger('Transformed friend request:', transformedResult);

    return transformedResult;
};

const handleUserNotFound = async (friendRequest) => {
    const { customShareMessage, requestCode } = friendRequest;
    const minifiedMessage = customShareMessage ? customShareMessage.replace(/\n\s*\n/g, '\n') : null;
    friendRequest.customShareMessage = minifiedMessage;
    
    const createdFriendRequest = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', createdFriendRequest);

    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendRequest.initiatedUserId });
    const initiatedUserName = userProfile.calledName || userProfile.firstName;

    const { contactType, contactMethod } = friendRequest.targetContactDetails;
    const initiatedUserId = friendRequest.initiatedUserId;

    const { referralCode } = userProfile;
    const downloadLink = config.get('templates.downloadLink');

    let dispatchResult = null;
    
    if (contactType === 'PHONE') {
        const initialPart = customShareMessage || format(config.get('templates.sms.friendRequest.template'), initiatedUserName);
        const linkPart = format(config.get('templates.sms.friendRequest.linkPart'), { downloadLink, referralCode, requestCode });
        logger(`Sending SMS: ${initialPart} ${linkPart}`);
        dispatchResult = await publisher.sendSms({ phoneNumber: contactMethod, message: `${initialPart} ${linkPart}` });
    }

    if (contactType === 'EMAIL') {
        const bodyTemplateKey = customShareMessage ? config.get('templates.email.custom.templateKey') : config.get('templates.email.default.templateKey');

        const templateVariables = { initiatedUserName, customShareMessage, downloadLink, referralCode, requestCode };
        const subject = format(config.get('templates.email.subject'), { initiatedUserName });

        dispatchResult = await publisher.sendSystemEmail({
            subject,
            toList: [contactMethod],
            bodyTemplateKey,
            templateVariables
        });
    }

    const context = { createdFriendRequest, dispatchResult };
    await publisher.publishUserEvent(initiatedUserId, 'FRIEND_REQUEST_INITIATED', { context });

    const transformedRequest = {
        type: 'INITIATED',
        requestId: createdFriendRequest.requestId,
        requestedShareItems: createdFriendRequest.requestedShareItems,
        creationTime: createdFriendRequest.creationTime,
        contactMethod
    };

    logger('Transformed request:', transformedRequest);

    return opsUtil.wrapResponse(transformedRequest);
};

/**
 * This function persists a new friendship request.
 * @param {Object} event
 * @property {String} initiatedUserId Required. The user id of the user initiating the friendship. Defaults to the sytem id in the request header.
 * @property {String} targetUserId Required in the absence of targetContactDetails. The user id of the user whose friendship is being requested.
 * @property {String} targetPhoneOrEmail Required in the absence of targetUserId. Either the phone or email of the user whose friendship is being requested.
 * @property {Array} requestedShareItems Specifies what the initiating user wants to share. Valid values include ACTIVITY_LEVEL, ACTIVITY_COUNT, SAVE_VALUES, and BALANCE
 */
module.exports.addFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;
    
        const friendRequest = opsUtil.extractParamsFromEvent(event);
        logger('Extracted friend request: ', friendRequest);
        if (!friendRequest.targetUserId && !friendRequest.targetPhoneOrEmail) {
            throw new Error('Error! targetUserId or targetPhoneOrEmail must be provided');
        }

        friendRequest.initiatedUserId = systemWideUserId;

        if (friendRequest.targetPhoneOrEmail) {
            friendRequest.targetContactDetails = extractValidateFormatContact(friendRequest.targetPhoneOrEmail);
            Reflect.deleteProperty(friendRequest, 'targetPhoneOrEmail');
        }

        if (friendRequest.customShareMessage) {
            const blacklist = new RegExp(config.get('templates.blacklist'), 'u');
            if (blacklist.test(friendRequest.customShareMessage)) {
                throw new Error(`Error: Invalid custom share message`);
            }
        }

        if (!friendRequest.targetUserId) {
            const targetContactDetails = friendRequest.targetContactDetails;
            const targetUserForFriendship = await checkForUserWithContact(targetContactDetails);
            if (!targetUserForFriendship) {
                friendRequest.requestCode = await generateRequestCode();
                return handleUserNotFound(friendRequest);
            }

            friendRequest.targetUserId = targetUserForFriendship.systemWideUserId;
        }
    
        logger('Assembled friend request: ', friendRequest);

        const createdFriendRequest = await persistenceWrite.insertFriendRequest(friendRequest);
        logger('Result of friend request insertion:', createdFriendRequest);

        const logEvents = [publisher.publishUserEvent(systemWideUserId, 'FRIEND_REQUEST_INITIATED', { context: { createdFriendRequest }})];
        if (friendRequest.targetUserId) {
            logEvents.push(publisher.publishUserEvent(friendRequest.targetUserId, 'FRIEND_REQUEST_RECEIVED', { context: { createdFriendRequest } }));
        }

        await Promise.all(logEvents);
        
        const transformedRequest = await appendUserNameToRequest(systemWideUserId, createdFriendRequest);
        logger('Transformed request:', transformedRequest);

        return opsUtil.wrapResponse(transformedRequest);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This will be used as a direct invocation. It just takes a referral code, finds the user that the code belongs to,
 * and then either create or stitch up a friend request to the new user
 * @param {Object} event Usual
 * @property {String} targetUserId The ID of the user that might become the target of the request, if found
 * @property {String} referralCodeUsed The referral code that was used to sign up
 * @property {String} countryCode The country code where this was used
 * @property {String} emailAddress The email address of the user (for searching in tables)
 * @property {String} phoneNumber The phone number of the user (same)
 */
module.exports.initiateRequestFromReferralCode = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'targetUserId')) {
            return { statusCode: 403 };
        }

        const { targetUserId, referralCodeUsed, countryCode } = event;
        const referralValidation = { referralCode: referralCodeUsed, countryCode, includeCreatingUserId: true };
        const { result, codeDetails } = await fetchAndExtractReferralDetails(referralValidation);
        
        if (result === 'CODE_NOT_FOUND' || !codeDetails || codeDetails.codeType !== 'USER') {
            return { result: 'NO_USER_CODE_FOUND' };
        }

        const { creatingUserId: initiatedUserId } = codeDetails;
        
        // lots to fix in here
        const { emailAddress, phoneNumber } = event;
        const contactMethod = emailAddress ? emailAddress : phoneNumber;
        const seekExistingRequest = await persistenceRead.findPossibleFriendRequest(initiatedUserId, contactMethod);
        logger('Sought existing request and found: ', seekExistingRequest);

        if (seekExistingRequest) {
            const resultOfUpdate = await persistenceWrite.connectTargetViaId(targetUserId, seekExistingRequest.requestId);
            logger('Finished up with the update: ', resultOfUpdate);
            return { result: 'CONNECTED' };
        }

        const friendshipRequest = { initiatedUserId, targetUserId, requestType: 'CREATE', requestedShareItems: ['SHARE_ACTIVITY'] };
        friendshipRequest.targetContactDetails = {
            contactType: emailAddress ? 'EMAIL' : 'PHONE',
            contactMethod: emailAddress || phoneNumber
        };

        const newRequest = await persistenceWrite.insertFriendRequest(friendshipRequest);
        logger('Result of creating request: ', newRequest);
        
        // we use a different event to that above, because this is different
        const eventContext = { targetUserId, initiatedUserId, referralCodeUsed, countryCode, codeDetails };
        const referringUserEvent = publisher.publishUserEvent(initiatedUserId, 'FRIEND_INITIATED_VIA_REFERRAL', { context: eventContext });
        const referredUserEvent = publisher.publishUserEvent(targetUserId, 'FRIEND_ACCEPTED_VIA_REFERRAL', { context: eventContext });
        await Promise.all([referringUserEvent, referredUserEvent]);

        return { result: 'CREATED' };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { result: 'FAILURE' };
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
            return opsUtil.wrapResponse({ result: 'NOT_FOUND' }, 404);
        }

        await publisher.publishUserEvent('FRIEND_REQUEST_CONNECTED_VIA_CODE', systemWideUserId, { requestCode, updateResult });
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { updateResult }});
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * This function returns an array of friend requests a user has not yet accepted (or ignored). Friend requests are
 * extracted for the system id in the request context.
 */
module.exports.findFriendRequestsForUser = async (event) => {
    try {    
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const params = opsUtil.extractParamsFromEvent(event);
        const userDetails = opsUtil.extractUserDetails(event);
        
        const systemWideUserId = userDetails ? userDetails.systemWideUserId : params.systemWideUserId;

        // get friend requests
        const friendRequestsForUser = await persistenceRead.fetchFriendRequestsForUser(systemWideUserId);
        logger('Got requests:', friendRequestsForUser);
        if (friendRequestsForUser.length === 0) {
            return opsUtil.wrapResponse([]); 
        }

        // for each request append the user name of the initiating user
        const appendUserNames = friendRequestsForUser.map((request) => appendUserNameToRequest(systemWideUserId, request));
        const transformedRequests = await Promise.all(appendUserNames);
        logger('Transformed requests:', transformedRequests);

        return opsUtil.wrapResponse(transformedRequests);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

// todo: consolidate like functions
const assembleFriendshipResponse = async (initiatedUserId, friendship, initiatorProfile) => {
    const accountIdMap = await persistenceRead.fetchAccountIdForUser(initiatedUserId);

    let profileSavingHeat = null;

    const accountId = accountIdMap[initiatedUserId];
    const savingHeatFromCache = await persistenceRead.fetchSavingHeatFromCache([accountId]);
    logger('Saving heat from cache:', savingHeatFromCache);

    if (savingHeatFromCache.length === 0) {
        const savingHeatFromLambda = await invokeSavingHeatLambda([accountId]);
        logger('Got caller saving heat from lambda:', savingHeatFromLambda);
        profileSavingHeat = savingHeatFromLambda[0];
    } else {
        profileSavingHeat = savingHeatFromCache[0];
    }

    logger('Got saving heat:', profileSavingHeat);

    const transformedProfile = {
        relationshipId: friendship.relationshipId,
        personalName: initiatorProfile.personalName,
        familyName: initiatorProfile.familyName,
        calledName: initiatorProfile.calledName ? initiatorProfile.calledName : initiatorProfile.personalName,
        contactMethod: initiatorProfile.phoneNumber || initiatorProfile.emailAddress,
        savingHeat: profileSavingHeat.savingHeat,
        shareItems: friendship.shareItems
    };

    logger('Assembled response:', transformedProfile);
    
    return transformedProfile;
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
            return { statusCode: 400, body: 'Error! Missing requestId' };
        }

        const friendshipRequest = await persistenceRead.fetchFriendshipRequestById(requestId);
        logger('Fetched friendship request:', friendshipRequest);
        if (!friendshipRequest) {
            return { statusCode: 404, body: 'Error! No request found for that ID' };
        }

        const { initiatedUserId, targetUserId } = friendshipRequest;
        if (targetUserId !== systemWideUserId) {
            return { statusCode: 400, body: 'Error! Accepting user is not friendship target' };
        }

        const [initiatedUser, targetUser] = await Promise.all([
            persistenceRead.fetchUserProfile({ systemWideUserId: initiatedUserId, forceCacheReset: true }),
            persistenceRead.fetchUserProfile({ systemWideUserId: targetUserId, forceCacheReset: true })
        ]);

        if (!ALLOWED_USER_STATUS.includes(initiatedUser.userStatus) || !ALLOWED_USER_STATUS.includes(targetUser.userStatus)) {
            return { statusCode: 400, body: 'Error! One or both users has not finished their first save yet'};
        }
        
        const creationResult = await persistenceWrite.insertFriendship(requestId, initiatedUserId, targetUserId, shareItems);
        logger('Result of friendship insertion:', creationResult);
        
        // NB: the target user of the established event is the user who initiated the request
        const eventContext = { initiatedUserId, targetUserId, creationResult };
        const acceptedEvent = publisher.publishUserEvent(systemWideUserId, 'FRIEND_REQUEST_TARGET_ACCEPTED', { context: eventContext }); 
        const establishedEvent = publisher.publishUserEvent(initiatedUserId, 'FRIEND_REQUEST_INITIATED_ACCEPTED', { context: eventContext });
        await Promise.all([acceptedEvent, establishedEvent]);

        const transformedResult = await assembleFriendshipResponse(initiatedUserId, creationResult, initiatedUser);

        return opsUtil.wrapResponse(transformedResult);        
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * todo : convert to taking request ID friend request received by a user. The difference between this function and the 
 * deactivateFriendship function is that this function ignores friendships that were never accepted.
 * @param {Object} event
 * @property {String} requestId The system id of the user to be ignored as a friend. Can only be called by target.
 */
module.exports.ignoreFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;
        const { requestId } = opsUtil.extractParamsFromEvent(event);

        const friendRequest = await persistenceRead.fetchFriendshipRequestById(requestId);
        if (systemWideUserId !== friendRequest.targetUserId) {
            return { statusCode: 403 };
        }

        const resultOfIgnore = await persistenceWrite.ignoreFriendshipRequest(requestId, systemWideUserId);
        logger('Friendship update result:', resultOfIgnore);

        await publisher.publishUserEvent(systemWideUserId, 'FRIEND_REQUEST_IGNORED', { context: { requestId, resultOfIgnore }});
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { resultOfIgnore }});
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * For when someone sent the request but now wants it gone. Unlike above, this cancels a specific request
 */
module.exports.cancelFriendshipRequest = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = userDetails;
        const { requestId } = opsUtil.extractParamsFromEvent(event);

        const friendRequest = await persistenceRead.fetchFriendshipRequestById(requestId);
        if (systemWideUserId !== friendRequest.initiatedUserId) {
            return { statusCode: 403 };
        }

        const resultOfCancel = await persistenceWrite.cancelFriendshipRequest(requestId);
        logger('Result of persisting cancellation: ', resultOfCancel);

        await publisher.publishUserEvent(systemWideUserId, 'FRIEND_REQUEST_CANCELLED', { context: { requestId, resultOfCancel }});
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

const dispatcher = {
    'initiate': (event) => exports.addFriendshipRequest(event),
    'accept': (event) => exports.acceptFriendshipRequest(event),
    'ignore': (event) => exports.ignoreFriendshipRequest(event),
    'cancel': (event) => exports.cancelFriendshipRequest(event),
    'connect': (event) => exports.connectFriendshipRequest(event),
    'list': (event) => exports.findFriendRequestsForUser(event),
    'seek': (event) => exports.seekFriend(event),
    'referral': (event) => exports.obtainReferralCode(event)
};

/**
 * This just directs friendship-request management, on the lines of the audience management API, to avoid excessive lambda
 * and API GW resource proliferation. Note: try-catch robustness is inside the methods, so not duplicating
 */
module.exports.directRequestManagement = async (event) => {
    if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
        return { statusCode: 403 };
    }

    const { operation } = opsUtil.extractPathAndParams(event);
    logger('Extracted operation from path: ', operation);

    const resultOfProcess = await dispatcher[operation.trim().toLowerCase()](event);
    logger('Final result: ', resultOfProcess);

    return resultOfProcess;
};
