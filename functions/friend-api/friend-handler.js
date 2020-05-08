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
    const includeLastActivityOfType = config.get('share.activities');
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

const stripDownToPermitted = (shareItems, transaction) => {
    logger('Stripping down, share items: ', shareItems, ' and transaction: ', transaction);
    if (!shareItems || shareItems.length === 0 || !shareItems.includes('LAST_ACTIVITY')) {
        logger('No share items, exit');
        return null;
    }

    const strippedActivity = {
        creationTime: transaction.creationTime,
        settlementTime: transaction.settlementTime 
    };

    if (shareItems && shareItems.includes('LAST_AMOUNT')) {
        strippedActivity.amount = transaction.amount;
        strippedActivity.unit = transaction.unit;
        strippedActivity.balance = transaction.balance;
    }

    return strippedActivity;
};

const transformProfile = (profile, friendships, userAccountMap, accountAndSavingHeatMap) => {
    // logger('Map thing: ', userAccountMap);
    const profileAccountId = userAccountMap[profile.systemWideUserId];
    // logger('Profile account ID: ', profileAccountId);
    logger('And from saving heat: ', accountAndSavingHeatMap[profileAccountId]);
    const { savingHeat, recentActivity } = accountAndSavingHeatMap[profileAccountId];
        
    const targetFriendship = friendships.filter((friendship) => friendship.initiatedUserId === profile.systemWideUserId ||
        friendship.acceptedUserId === profile.systemWideUserId)[0];

    logger('Got target friendship:', targetFriendship);

    const expectedActivities = config.get('share.activities');
    logger('Recent activity: ', recentActivity);
    const extractShareableDetails = (activity) => stripDownToPermitted(targetFriendship.shareItems, recentActivity[activity]);
    
    const lastActivity = expectedActivities.reduce((obj, activity) => ({ ...obj, [activity]: extractShareableDetails(activity) }), {});

    const transformedProfile = {
        relationshipId: targetFriendship.relationshipId,
        personalName: profile.personalName,
        familyName: profile.familyName,
        calledName: profile.calledName ? profile.calledName : profile.personalName,
        contactMethod: profile.phoneNumber || profile.emailAddress,
        shareItems: targetFriendship.shareItems,
        savingHeat,
        lastActivity
    };
    
    return transformedProfile;
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
    logger('Map: ', accountAndSavingHeatMap);

    const profilesWithSavingHeat = profiles.map((profile) => transformProfile(profile, friendships, userAccountMap, accountAndSavingHeatMap));

    logger('Got profiles with savings heat:', profilesWithSavingHeat);

    return profilesWithSavingHeat;
};

/**
 * The function fetches the user profile and saving heat for the calling user. It differs from the
 * appendSavingHeatToProfiles process in that it does not seek friendships
 * @param {string} systemWideUserId 
 */
const fetchOwnSavingHeat = async (systemWideUserId) => {
    const userAccountMap = await persistenceRead.fetchAccountIdForUser(systemWideUserId);
    const accountId = userAccountMap[systemWideUserId];
    logger(`Got account id: ${accountId}`);

    let savingHeat = null;

    const savingHeatFromCache = await fetchSavingHeatFromCache([accountId]);
    logger('Got caller saving heat from cache:', savingHeatFromCache);

    if (savingHeatFromCache.length === 0) {
        const savingHeatFromLambda = await invokeSavingHeatLambda([accountId]);
        logger('Got caller saving heat from lambda:', savingHeatFromLambda);
        savingHeat = savingHeatFromLambda[0].savingHeat;
    } else {
        savingHeat = savingHeatFromCache[0].savingHeat;
    }

    logger('Got saving heat:', savingHeat);

    return { relationshipId: 'SELF', savingHeat };
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

        const profilesWithSavingHeat = await appendSavingHeatToProfiles(friendProfiles, userAccountMap, friendships);

        // todo: reuse above infra for user
        const savingHeatForCallingUser = await fetchOwnSavingHeat(systemWideUserId);
        profilesWithSavingHeat.push(savingHeatForCallingUser);
        
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
        
        const bundledResponse = await lambda.invoke(referralInvocation).promise();
        const extractedPayload = JSON.parse(bundledResponse.Payload);
        const { result, codeDetails } = JSON.parse(extractedPayload.body);
        logger('Code fetch result: ', result);
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
    const customShareMessage = friendRequest.customShareMessage ? friendRequest.customShareMessage : null;
    friendRequest.customShareMessage = customShareMessage ? String(customShareMessage.length) : null;
    const createdFriendRequest = await persistenceWrite.insertFriendRequest(friendRequest);
    logger('Persisting friend request resulted in:', createdFriendRequest);

    const userProfile = await persistenceRead.fetchUserProfile({ systemWideUserId: friendRequest.initiatedUserId });
    const initiatedUserName = userProfile.calledName ? userProfile.calledName : userProfile.firstName;

    const { contactType, contactMethod } = friendRequest.targetContactDetails;
    const initiatedUserId = friendRequest.initiatedUserId;

    let dispatchResult = null;

    if (contactType === 'PHONE') {
        const dispatchMsg = customShareMessage
            ? customShareMessage
            : format(config.get('templates.sms.friendRequest.template'), initiatedUserName);
        
        dispatchResult = await publisher.sendSms({ phoneNumber: contactMethod, message: dispatchMsg });
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
    }

    const context = { createdFriendRequest, dispatchResult };
    await publisher.publishUserEvent(initiatedUserId, 'FRIEND_REQUEST_CREATED', { context });

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
        await publisher.publishUserEvent(systemWideUserId, 'FRIEND_REQUEST_CREATED', { context: { createdFriendRequest } });
        
        const transformedRequest = await appendUserNameToRequest(systemWideUserId, createdFriendRequest);
        logger('Transformed request:', transformedRequest);

        return opsUtil.wrapResponse(transformedRequest);
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
const assembleFriendshipResponse = async (initiatedUserId, friendship) => {
    const [profile, accountId] = await Promise.all([
        persistenceRead.fetchUserProfile({ systemWideUserId: initiatedUserId }),
        persistenceRead.fetchAccountIdForUser(initiatedUserId)
    ]);

    let profileSavingHeat = null;

    const savingHeatFromCache = await fetchSavingHeatFromCache([accountId]);
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
        personalName: profile.personalName,
        familyName: profile.familyName,
        calledName: profile.calledName ? profile.calledName : profile.personalName,
        contactMethod: profile.phoneNumber || profile.emailAddress,
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
            throw new Error('Error! Missing requestId');
        }

        const friendshipRequest = await persistenceRead.fetchFriendshipRequestById(requestId);
        logger('Fetched friendship request:', friendshipRequest);
        if (!friendshipRequest) {
            throw new Error(`Error! No friend request found for request id: ${requestId}`);
        }

        const { initiatedUserId, targetUserId } = friendshipRequest;
        if (targetUserId === systemWideUserId) {
            const creationResult = await persistenceWrite.insertFriendship(requestId, initiatedUserId, targetUserId, shareItems);
            logger('Result of friendship insertion:', creationResult);
            await publisher.publishUserEvent(systemWideUserId, 'FRIEND_REQUEST_ACCEPTED', { context: { ...creationResult } });
            const transformedResult = await assembleFriendshipResponse(initiatedUserId, creationResult);

            return opsUtil.wrapResponse(transformedResult);
        }
    
        throw new Error('Error! Accepting user is not friendship target');
        
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
