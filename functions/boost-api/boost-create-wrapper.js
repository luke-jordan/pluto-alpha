'use strict';

const logger = require('debug')('jupiter:boost:create-wrapper');
const config = require('config');
const status = require('statuses');

const boostCreateHandler = require('./boost-create-handler');

const opsUtil = require('ops-util-common');
const boostUtil = require('./boost.util');

const rds = require('./persistence/rds.boost');
const dynamo = require('dynamo-common');
const publisher = require('publish-common');

// /////////////////////// SECTION FOR WRAPPER (FOR ADMIN FRONTEND CALLS) AND USER-GENERATED BOOSTS, I.E., FRIEND TOURNAMENTS ///

// todo next : get some basic defaults here, e.g., minimum number in tournament, and the Jupiter contribution (make dynamic)

const handleError = (err) => {
    logger('FATAL_ERROR: ', err);
    return { statusCode: status('Internal Server Error'), body: JSON.stringify(err.message) };
};

const isValidFriendTournament = (event) => {
    const params = boostUtil.extractEventBody(event);
    logger('Checking if friend tournament, after being passed params: ', params);
    if (params.boostAudienceSelection) {
        logger('Have an audience selection, canont be friend based');
        return false;
    }

    const { friendships, rewardParameters } = params;
    if (!Array.isArray(friendships) || friendships.length === 0) {
        return false;
    }

    if (!rewardParameters || rewardParameters.rewardType !== 'POOLED') {
        return false;
    }

    return true;
};

const assembleBoostAudienceSelection = async (creatingUserId, friendshipIds) => {
    const userIdsForFriends = await rds.fetchUserIdsForRelationships(friendshipIds);
    logger('Got user ID pairs for the friendship list:', userIdsForFriends);

    // this is to make sure user only creates the tournament for users actually in a friend relationship with them
    const validFriendships = userIdsForFriends.filter((friendship) => Object.values(friendship).includes(creatingUserId));
    const friendUserIds = validFriendships.map((relationship) => {
        const friendUserId = relationship.initiatedUserId === creatingUserId ? relationship.acceptedUserId : relationship.initiatedUserId;
        return friendUserId;
    });

    logger('Got friend user ids:', friendUserIds);

    if (friendUserIds.length === 0) {
        throw new Error('Error! No valid friendships found');
    }

    const selectionCondition = { op: 'in', prop: 'systemWideUserId', value: [creatingUserId, ...friendUserIds] };

    return { friendUserIds, selectionCondition };
};

// obtain, for client-float, current values for: (1) max pool entry amount, (2) max percent for pool amount, 
// (3) bonus pool to use for this, (4) the current pool contribution, (5) subsequent boost budget
const fetchProfileAndFloatParams = async (creatingUserId) => {
    const userProfile = await dynamo.fetchSingleRow(config.get('tables.profileTable'), { systemWideUserId: creatingUserId });
    
    const { clientId, floatId, personalName, calledName } = userProfile;
    const clientFloatData = await dynamo.fetchSingleRow(config.get('tables.clientFloatTable'), { clientId, floatId });

    const { friendTournamentParameters, currency } = clientFloatData;
    logger('Retrieved tournament parameters: ', friendTournamentParameters);

    const { maxPoolEntry, maxPoolPercent, clientFloatContribution } = friendTournamentParameters;
    const bonusPoolId = friendTournamentParameters.bonusPoolId || clientFloatData.bonusPoolSystemWideId;

    return { maxPoolEntry, maxPoolPercent, clientFloatContribution, bonusPoolId, clientId, floatId, currency, personalName, calledName };
};

const constructStatusConditionsForFriendTournament = (gameParams, poolContributionPerUser) => {
    const entryAmountCondition = `save_event_greater_than #{${opsUtil.convertAmountDictToString(poolContributionPerUser)}}`;
    const thisBoostCondition = `save_tagged_with #{THIS_BOOST}`;

    const entryConditionPrefix = gameParams.gameType === 'DESTROY_IMAGE' ? 'percent_destroyed_above' : 'number_taps_greater_than';
    const entryCondition = `${entryConditionPrefix} #{0::${gameParams.timeLimitSeconds * 1000}}`;

    const winningConditionPrefix = gameParams.gameType === 'DESTROY_IMAGE' ? 'percent_destroyed_in_first_N' : 'number_taps_in_first_N';
    const winningCondition = `${winningConditionPrefix} #{1::${gameParams.timeLimitSeconds * 1000}}`;

    return {
        UNLOCKED: [entryAmountCondition, thisBoostCondition],
        PENDING: [entryCondition],
        REDEEMED: [winningCondition]
    };
};

const createFriendTournament = async (params) => {
    const { creatingUserId, friendships, gameParams, rewardParameters: rewardParams } = params;
    const [audienceSelection, clientFloatParams] = await Promise.all([
        assembleBoostAudienceSelection(creatingUserId, friendships),
        fetchProfileAndFloatParams(creatingUserId)
    ]);

    logger('Created friendship-based audience selection instruction:', audienceSelection);

    const { poolContributionPerUser } = rewardParams;
    const { maxPoolEntry } = clientFloatParams;
    
    logger('Max pool entry: ', maxPoolEntry, ' vs psased contribution: ', poolContributionPerUser);
    const maxEntryInSameUnit = opsUtil.convertToUnit(maxPoolEntry.amount, maxPoolEntry.unit, poolContributionPerUser.unit);
    const entryAmount = Math.min(maxEntryInSameUnit, poolContributionPerUser.amount);

    const percentPoolAsReward = Math.min(clientFloatParams.maxPoolPercent, rewardParams.percentPoolAsReward);
    const { clientFloatContribution } = clientFloatParams;

    const rewardParameters = {
        rewardType: 'POOLED',
        percentPoolAsReward,
        poolContributionPerUser: {
            ...poolContributionPerUser,
            amount: entryAmount
        },
        clientFloatContribution
    };

    logger('Calculating boost budget from entry amount: ', entryAmount, ' and percent: ', percentPoolAsReward);
    const clientProportion = clientFloatContribution && clientFloatContribution.type === 'PERCENT_OF_POOL' 
        ? clientFloatContribution.value : 0;
    const boostBudget = Math.round(entryAmount * (percentPoolAsReward + clientProportion) * (friendships.length + 1));

    gameParams.numberWinners = 1; // we enforce this for now

    if (gameParams.gameType === 'CHASE_ARROW' && !gameParams.arrowSpeedMultiplier) { // present UI does not allow selection, so have here
        gameParams.arrowSpeedMultiplier = 5;
    }

    if (gameParams.gameType === 'DESTROY_IMAGE' && !gameParams.tapsPerSquare) {
        gameParams.tapsPerSquare = 8; // seems to be optimal from first plays
    }
    
    const statusConditions = constructStatusConditionsForFriendTournament(gameParams, rewardParameters.poolContributionPerUser);

    const boostParameters = {
        creatingUserId,
        label: params.label,
        boostTypeCategory: `GAME::${gameParams.gameType}`,
        endTimeMillis: params.endTimeMillis,
        boostAudienceType: 'SOCIAL',
        boostAudienceSelection: { conditions: [audienceSelection.selectionCondition] },
        
        initialStatus: 'OFFERED',
        gameParams,
        statusConditions,

        boostSource: {
            bonusPoolId: clientFloatParams.bonusPoolId,
            clientId: clientFloatParams.clientId,
            floatId: clientFloatParams.floatId
        },
        rewardParameters,

        // because unpredictable, set amount to zero (redemption handler calcs from contributions)
        boostAmountOffered: `0::HUNDREDTH_CENT::${clientFloatParams.currency}`,
        boostBudget,

        flags: ['FRIEND_TOURNAMENT']
    };

    logger('Assembled parameters for boost: ', boostParameters);
    const resultOfCreation = await boostCreateHandler.createBoost(boostParameters);
    logger('result of creation: ', resultOfCreation);

    const { boostId } = resultOfCreation;
    const createdBoost = await rds.fetchBoost(boostId);

    // need tournament name, friend name, entry amount, pool amount, pool contribution, pool threshold
    const needCentsInBonus = opsUtil.convertToUnit(boostBudget, poolContributionPerUser.unit, 'WHOLE_CENT') % 100 !== 0;
    const messageParameters = {
        friendName: clientFloatParams.calledName || clientFloatParams.personalName,
        tournamentName: params.label,
        entryAmount: opsUtil.formatAmountCurrency(rewardParameters.poolContributionPerUser),
        bonusAmountMax: opsUtil.formatAmountCurrency({ ...poolContributionPerUser, amount: boostBudget }, needCentsInBonus ? 2 : 0)
    };
    
    if (clientFloatContribution.requiredFriends) {
        messageParameters.friendsForBonus = clientFloatContribution.requiredFriends;
    }
    const logContext = { boostId, messageParameters };

    const eventOptions = { initiator: creatingUserId, context: logContext };
    await Promise.all([
        publisher.publishMultiUserEvent(audienceSelection.friendUserIds, 'INVITED_TO_FRIEND_TOURNAMENT', eventOptions),
        publisher.publishUserEvent(creatingUserId, 'CREATED_FRIEND_TOURNAMENT', { context: logContext })
    ]);
    
    return { result: 'SUCCESS', createdBoost };
};

/**
 * Wrapper method for API gateway, handling authorization via the header, extracting body, etc. 
 * @param {object} event An event object containing the request context and request body.
 * @property {object} requestContext An object containing the callers id, role, and permissions. The event will not be processed without a valid request context.
 * @property {string} creatingUserId The system wide user id of the user who is creating the boost.
 * @property {string} boostTypeCategory A composite string containing the boost type and the boost category, seperated by '::'. For example, 'SIMPLE::TIME_LIMITED'.
 * @property {string/number} boostBudget This may either be a number or a composite key containing the amount, the unit, and the currency, seperated by '::', e.g '10000000::HUNDREDTH_CENT::USD'.
 * @property {string} startTimeMillis A moment formatted date string indicating when the boost should become active. Defaults to now if not passed in by caller.
 * @property {string} endTimeMillis Epoch millis for when the boost expires. Defaults to 50 years from now (true at time of writing, configuration may change).
 * @property {object} boostSource An object containing the bonusPoolId, clientId, and floatId associated with the boost being created.
 * @property {array}  friendships An optional array of relationship ids. Used to create a custom boost audience targeted at the users in the relationships.
 * @property {object} rewardParameters An object caontaining reward parameters to be persisted with the boost.
 * @property {object} statusConditions An object containing an string array of DSL instructions containing details like how the boost should be saved.
 * @property {string} boostAudienceType A string denoting the boost audience. Valid values include GENERAL and INDIVIDUAL.
 * @property {string} boostAudienceSelection A selection instruction for the audience for the boost. Primarily for internal invocations.
 * @property {array}  redemptionMsgInstructions An optional array containing message instruction objects. Each instruction object typically contains the accountId and the msgInstructionId.
 * @property {object} messageInstructionFlags An optional object with details on how to extract default message instructions for the boost being created.
 */
module.exports.createBoostWrapper = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);

        logger('Boost create, user details: ', userDetails);
        if (!userDetails) {
            return { statusCode: status('Forbidden') };
        }

        const isUserAdmin = userDetails.role === 'SYSTEM_ADMIN';
        const isUserGeneratedTournament = isValidFriendTournament(event);

        if (!isUserAdmin && !isUserGeneratedTournament) {
            return { statusCode: status('Forbidden') };
        }

        const params = boostUtil.extractEventBody(event);
        logger('Boost create, received params: ', params);
        params.creatingUserId = userDetails.systemWideUserId;

        if (isUserGeneratedTournament) {
            const resultOfTournamentCreation = await createFriendTournament(params);
            return boostUtil.wrapHttpResponse(resultOfTournamentCreation);
        }

        const resultOfCall = await boostCreateHandler.createBoost(params);
        return boostUtil.wrapHttpResponse(resultOfCall);    
    } catch (err) {
        return handleError(err);
    }
};
