'use strict';

const logger = require('debug')('jupiter:friends:main');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const persistenceRead = require('./persistence/read.friends');
const persistenceWrite = require('./persistence/write.friends');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

// note: remove what follows as soon as confident all end user apps are on new saving heat model
// (it serves to convert the newly dynamic heats into the hard-coded levels the prior model required)
const GRANDFATHER_HEAT = {
    'Chilly': 0, 
    'Tropical': 1.1, 
    'Golden': 5.1, 
    'Blazing': 10.1
};

// sending back as number will cause an overly terse ternary in app to crash, so must be string
const convertHeatToLegacy = (currentHeat) => Number((currentHeat && GRANDFATHER_HEAT[currentHeat.levelName]) || 0).toFixed(2);

const invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const invokeSavingHeatLambda = async (userIds) => {
    const includeLastActivityOfType = config.get('share.activities');
    const savingHeatLambdaInvoke = invokeLambda(config.get('lambdas.calcSavingHeat'), { userIds, includeLastActivityOfType });
    logger('Invoke savings heat lambda with arguments: ', savingHeatLambdaInvoke);
    const savingHeatResult = await lambda.invoke(savingHeatLambdaInvoke).promise();
    logger('Result of savings heat calculation: ', savingHeatResult);
    const heatPayload = JSON.parse(savingHeatResult.Payload);
    const { userHeatMap } = heatPayload;
    return userHeatMap;
};

const stripDownToPermitted = (shareItems, transaction) => {
    logger('Stripping down, share items: ', shareItems, ' and transaction: ', transaction);
    if (!shareItems || shareItems.length === 0 || !shareItems.includes('LAST_ACTIVITY')) {
        logger('No share items, exit');
        return null;
    }

    if (!transaction) { 
        logger('No transaction in activity list, exit');
        return null;
    }

    const strippedActivity = {
        creationTime: moment(transaction.creationTime).valueOf()
    };

    if (shareItems && shareItems.includes('LAST_AMOUNT')) {
        strippedActivity.amount = transaction.amount;
        strippedActivity.unit = transaction.unit;
        strippedActivity.balance = transaction.balance;
    }

    return strippedActivity;
};

const transformProfile = async (profile, friendshipDetails, userHeatMap) => {
    const { systemWideUserId } = profile;

    const { friendships, mutualFriendCounts } = friendshipDetails;
    const { currentLevel, recentActivity } = userHeatMap[systemWideUserId];
    const savingHeat = convertHeatToLegacy(currentLevel);
    
    const targetFriendship = friendships.filter((friendship) => friendship.initiatedUserId === systemWideUserId ||
        friendship.acceptedUserId === systemWideUserId)[0];

    logger('Got target friendship:', targetFriendship);

    const expectedActivities = config.get('share.activities');
    logger('Recent activity: ', recentActivity);
    const extractShareableDetails = (activity) => stripDownToPermitted(targetFriendship.shareItems, recentActivity[activity]);
    
    const lastActivity = expectedActivities.reduce((obj, activity) => ({ ...obj, [activity]: extractShareableDetails(activity) }), {});

    const mutualFriendCount = mutualFriendCounts.filter((count) => typeof count[systemWideUserId] === 'number');
    const numberOfMutualFriends = mutualFriendCount[0][systemWideUserId];
    logger('Mutual friends:', numberOfMutualFriends);

    const transformedProfile = {
        relationshipId: targetFriendship.relationshipId,
        personalName: profile.personalName,
        familyName: profile.familyName,
        calledName: profile.calledName ? profile.calledName : profile.personalName,
        contactMethod: profile.phoneNumber || profile.emailAddress,
        shareItems: targetFriendship.shareItems,
        savingHeat,
        lastActivity,
        numberOfMutualFriends
    };
    
    return transformedProfile;
};

/**
 * This function appends a savings heat score to each profile. The savings heat is either fetched from cache or
 * calculated by the savings heat lambda.
 * @param {Array} profiles An array of user profiles.
 * @param {Object} userAccountMap An object mapping user system ids to thier account ids. Keys are user ids, values are account ids.
 */
const appendSavingHeatToProfiles = async (profiles, friendshipDetails, savingHeatForUsers) => {
    logger('Got savings heat from lambda:', savingHeatForUsers);

    const profilesWithSavingHeat = await Promise.all(
        profiles.map((profile) => transformProfile(profile, friendshipDetails, savingHeatForUsers))
    );

    logger('Got profiles with savings heat:', profilesWithSavingHeat);

    return profilesWithSavingHeat.filter((profile) => !opsUtil.isObjectEmpty(profile));
};

/**
 * The function fetches the user profile and saving heat for the calling user. It differs from the
 * appendSavingHeatToProfiles process in that it does not seek friendships
 * @param {string} systemWideUserId 
 */
const fetchOwnSavingHeat = (systemWideUserId, savingHeatForUsers) => {
    const ownHeatLevel = savingHeatForUsers[systemWideUserId];
    logger('Got own saving heat level: ', ownHeatLevel);
    const savingHeat = convertHeatToLegacy(ownHeatLevel);

    return { relationshipId: 'SELF', savingHeat };
};

/**
 * This functions accepts a users system id and returns the user's friends.
 * @param {Object} event
 * @property {String} systemWideUserId Required. The system id of the user whose friends are to be extracted.
 */
module.exports.obtainFriends = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            logger('No event! Must be warmup lambda, just keep going and exit');
            return { statusCode: 400, body: 'Empty invocation' };
        }
      
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

        const mutualFriendCounts = await persistenceRead.countMutualFriends(systemWideUserId, friendUserIds);
        logger('Got mutual friend counts:', mutualFriendCounts);

        const friendshipDetails = { friendships, mutualFriendCounts };
    
        const profileRequests = friendUserIds.map((userId) => persistenceRead.fetchUserProfile({ systemWideUserId: userId }));
        const friendProfiles = await Promise.all(profileRequests);
        logger('Got friend profiles:', friendProfiles.length);

        const userIds = [...friendProfiles.map((profile) => profile.systemWideUserId), systemWideUserId];
        const savingHeatForUsers = await invokeSavingHeatLambda(userIds); // i.e., using user IDs 

        const profilesWithSavingHeat = await appendSavingHeatToProfiles(friendProfiles, friendshipDetails, savingHeatForUsers);

        const savingHeatForCallingUser = fetchOwnSavingHeat(systemWideUserId, savingHeatForUsers);
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
