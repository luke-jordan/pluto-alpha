'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');

const validator = require('validator');
const randomWord = require('random-words');
const format = require('string-format');
const camelcase = require('camelcase');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const Redis = require('ioredis');
const redis = new Redis({
    port: config.get('cache.port'),
    host: config.get('cache.host'),
    retryStrategy: () => `dont retry`,
    keyPrefix: `${config.get('cache.keyPrefixes.savingHeat')}::`
});

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const invokeSavingHeatLambda = async (accountIds) => {
    const includeLastActivityOfType = config.get('share.userActivities');
    const savingHeatLambdaInvoke = invokeLambda(config.get('lambdas.calcSavingHeat'), { accountIds, includeLastActivityOfType });
    logger('Invoke savings heat lambda with arguments: ', savingHeatLambdaInvoke);
    const savingHeatResult = await lambda.invoke(savingHeatLambdaInvoke).promise();
    logger('Result of savings heat calculation: ', savingHeatResult);
    const heatPayload = JSON.parse(savingHeatResult.Payload);
    const { details } = heatPayload;
    return details;
};

const fetchSavingHeatFromCache = async (accountIds) => {
    const cachedSavingHeatForAccounts = await redis.mget(...accountIds);
    logger('Got cached savings heat for accounts:', cachedSavingHeatForAccounts);
    return cachedSavingHeatForAccounts.filter((result) => result !== null).map((result) => JSON.parse(result));
};

const transformProfile = (profile, friendships, userAccountMap, accountAndSavingHeatMap) => {
    const profileAccountId = userAccountMap[profile.systemWideUserId];
    const profileSavingHeat = accountAndSavingHeatMap[profileAccountId];
    Reflect.deleteProperty(profileSavingHeat, 'accountId');
    logger('Got savings heat for profile:', profileSavingHeat);

    const targetFriendship = friendships.filter((friendship) => friendship.initiatedUserId === profile.systemWideUserId ||
        friendship.acceptedUserId === profile.systemWideUserId);
    logger('Got target friendship:', targetFriendship);

    profile.relationshipId = targetFriendship[0].relationshipId;
    Reflect.deleteProperty(profile, 'systemWideUserId');

    const allowedShareItems = config.get('share.allowedShareItems');
    const userActivities = config.get('share.userActivities');

    allowedShareItems.forEach((allowedShareItem) => {
        if (!targetFriendship[0].shareItems.includes(allowedShareItem)) {
            userActivities.forEach((activity) => {
                if (profileSavingHeat[activity]) {
                    Reflect.deleteProperty(profileSavingHeat[activity], camelcase(allowedShareItem));
                }
            });
        }
    });
    
    profile.shareItems = profileSavingHeat;
    return profile;
};

/**
 * This function appends a savings heat score to each profile. The savings heat is either fetched from cache or
 * calculated by the savings heat lambda.
 * @param {Array} profiles An array of user profiles.
 * @param {Object} userAccountMap An object mapping user system ids to thier account ids. Keys are user ids, values are account ids.
 */
const appendSavingHeatToProfiles = async (profiles, userAccountMap, friendships) => {
    const accountIds = Object.values(userAccountMap);
    
    const cachedSavingHeatForAccounts = await fetchSavingHeatFromCache(accountIds);
    logger('Found cached savings heat:', cachedSavingHeatForAccounts);

    const cachedAccounts = cachedSavingHeatForAccounts.map((savingHeat) => savingHeat.accountId);
    const uncachedAccounts = accountIds.filter((accountId) => !cachedAccounts.includes(accountId));

    logger('Found uncached accounts:', uncachedAccounts);
    logger('Got cached accounts:', cachedAccounts);

    let savingHeatFromLambda = [];
    if (uncachedAccounts.length > 0) {
        savingHeatFromLambda = await invokeSavingHeatLambda(uncachedAccounts);
    }

    logger('Got savings heat from lambda:', savingHeatFromLambda);

    const savingHeatForAccounts = [...savingHeatFromLambda, ...cachedSavingHeatForAccounts];
    logger('Aggregated savings heat from cache and lambda:', savingHeatForAccounts);

    const accountAndSavingHeatMap = savingHeatForAccounts.reduce((obj, savingHeat) => ({ ...obj, [savingHeat.accountId]: savingHeat }), {});

    const profilesWithSavingHeat = profiles.map((profile) => transformProfile(profile, friendships, userAccountMap, accountAndSavingHeatMap));

    logger('Got profiles with savings heat:', profilesWithSavingHeat);

    return profilesWithSavingHeat;
};


/**
 * This functions accepts a users system id and returns the user's friends.
 * @param {Object} event
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
    
        const userFriendshipMap = await persistenceRead.fetchActiveSavingFriendsForUser(systemWideUserId);
        logger('Got user friendship map:', userFriendshipMap);
        
        const friendships = userFriendshipMap[systemWideUserId];
        logger('Got user friendships:', friendships);
        if (!friendships || friendships.length === 0) {
            return opsUtil.wrapResponse([]);
        }

        const friendUserIds = friendships.map((friendship) => friendship.initiatedUserId || friendship.acceptedUserId);
        logger('Got user ids:', friendUserIds);
    
        const profileRequests = friendUserIds.map((userId) => persistenceRead.fetchUserProfile({ systemWideUserId: userId }));
        const friendProfiles = await Promise.all(profileRequests);
        logger('Got friend profiles:', friendProfiles);

        const userAccountArray = await Promise.all(friendUserIds.map((userId) => persistenceRead.fetchAccountIdForUser(userId)));
        logger('Got user accounts from persistence:', userAccountArray);
        const userAccountMap = userAccountArray.reduce((obj, userAccountObj) => ({ ...obj, ...userAccountObj }), {});

        // todo : do not include user ID in what is sent back, but tdo include friendship ID
        // (probably requires modification to getFriendIdsForUser to return both as well)
        const profilesWithSavingHeat = await appendSavingHeatToProfiles(friendProfiles, userAccountMap, friendships);
        
        return opsUtil.wrapResponse(profilesWithSavingHeat);
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

const handleUserNotFound = async (friendRequest) => {
    const customShareMessage = friendRequest.customShareMessage ? friendRequest.customShareMessage : null;
    friendRequest.customShareMessage = customShareMessage ? String(customShareMessage.length) : null;
    const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', insertionResult);

    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendRequest.initiatedUserId });
    const initiatedUserName = userProfile.calledName ? userProfile.calledName : userProfile.firstName;

    const { contactType, contactMethod } = friendRequest.targetContactDetails;

    let dispatchResult = null;

    if (contactType === 'PHONE') {
        const dispatchMsg = customShareMessage
            ? customShareMessage
            : format(config.get('templates.sms.friendRequest.template'), initiatedUserName);
        
        dispatchResult = await publisher.sendSms({ phoneNumber: contactMethod, message: dispatchMsg });
        return opsUtil.wrapResponse({ result: 'SUCCESS', updateLog: { insertionResult, dispatchResult }});
    }

    if (contactType === 'EMAIL') {
        const bodyTemplateKey = customShareMessage
            ? config.get('templates.email.custom.templateKey')
            : config.get('templates.email.default.templateKey');

        const templateVariables = customShareMessage ? { customShareMessage } : { initiatedUserName };

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

const extractValidateFormatContact = (phoneOrEmail) => {
    const contactType = identifyContactType(phoneOrEmail);
    if (!contactType) {
        throw new Error(`Error! Invalid target contact: ${phoneOrEmail}`);
    }

    let contactMethod = '';
    if (contactType === 'EMAIL') {
        contactMethod = phoneOrEmail.trim().toLowerCase();
    }

    if (contactType === 'PHONE') {
        contactMethod = phoneOrEmail; // todo : apply simple formatting
    }

    return { contactType, contactMethod };
};

const checkForUserWithContact = async (contactDetails) => {
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
        const referralInvocation = invokeLambda(config.get('lambdas.referralDetails'), referralPayload, true);
        return lambda.invoke(referralInvocation).promise();
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
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
        const insertionResult = await persistenceWrite.insertFriendRequest(friendRequest);
        logger('Result of friend request insertion:', insertionResult);
    
        return opsUtil.wrapResponse({ result: 'SUCCESS', requestId: insertionResult.requestId });
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

const appendUserNameToRequest = async (userId, friendRequest) => {
    const type = friendRequest.targetUserId === userId ? 'RECEIVED' : 'INITIATED';
    const friendUserId = type === 'INITIATED' 
        ? friendRequest.targetUserId
        : friendRequest.initiatedUserId;

    const profile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendUserId });
    logger('Got friend profile:', profile);

    const transformedResult = {
        type,
        requestId: friendRequest.requestId,
        requestCode: friendRequest.requestCode,
        requestedShareItems: friendRequest.requestedShareItems,
        creationTime: friendRequest.creationTime,
        personalName: profile.personalName,
        familyName: profile.familyName,
        calledName: profile.calledName ? profile.calledName : profile.personalName
    };

    if (type === 'INITIATED') {
        if (friendRequest.targetContactDetails) {
            transformedResult.contactMethod = friendRequest.targetContactDetails.contactMethod;
        }
    }

    if (type === 'RECEIVED') {
        const mutualFriendCount = await persistenceRead.countMutualFriends(userId, [friendUserId]);
        transformedResult.numberOfMutualFriends = mutualFriendCount[0][friendUserId];
    }

    if (friendRequest.customShareMessage) {
        transformedResult.customShareMessage = friendRequest.customShareMessage;
    }

    logger('Transformed friend request:', transformedResult);

    return transformedResult;
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
 * Proto-function intended to ignore a friend request received by a user. The difference between this function and the 
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

const dispatcher = {
    'initiate': (event) => exports.addFriendshipRequest(event),
    'accept': (event) => exports.acceptFriendshipRequest(event),
    'ignore': (event) => exports.ignoreFriendshipRequest(event),
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
