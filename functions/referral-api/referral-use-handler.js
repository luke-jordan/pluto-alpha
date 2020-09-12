'use strict';

const logger = require('debug')('jupiter:referral:handler');
const config = require('config');
const status = require('statuses');
const moment = require('moment');

const camelCaseKeys = require('camelcase-keys');

const dynamo = require('dynamo-common');
const opsUtil = require('ops-util-common');
const publisher = require('publish-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const handleErrorAndReturn = (e) => {
    logger('FATAL_ERROR: ', e);
    return { statusCode: 500, body: JSON.stringify(e.message) };
};

const standardCodeColumns = ['referralCode', 'codeType', 'expiryTimeMillis', 'context', 'clientId', 'floatId'];

const fetchReferralCodeDetails = async (rawReferralCode, countryCode, relevantColumns) => {
    if (!rawReferralCode || typeof rawReferralCode !== 'string') {
        return null;
    }

    const referralCode = rawReferralCode.toUpperCase().trim();
    logger('Verifying transformed referral code: ', referralCode);
    
    const colsToReturn = relevantColumns ? relevantColumns : standardCodeColumns;
    const referralCodeDetails = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { referralCode, countryCode }, colsToReturn);
    logger('Found referral code in table: ', referralCodeDetails);
    
    if (opsUtil.isObjectEmpty(referralCodeDetails)) {
        return null;
    }

    return referralCodeDetails;
};

const fetchUserReferralDefaults = async (clientId, floatId) => {
    const clientFloatTable = config.get('tables.clientFloatTable');
    const colsToReturn = ['user_referral_defaults'];

    const tableLookUpResult = await dynamo.fetchSingleRow(clientFloatTable, { clientId, floatId }, colsToReturn);
    logger('Got user referral defaults from table: ', tableLookUpResult);

    if (!tableLookUpResult || opsUtil.isObjectEmpty(tableLookUpResult.userReferralDefaults)) {
        return null;
    }

    return camelCaseKeys(tableLookUpResult.userReferralDefaults);
};

/**
 * This function verifies a referral code.
 * @param {object} event An event object containing the referral code to be evaluated.
 * @property {string} countryCode The country where the referral code is being used
 * @property {string} referralCode The referralCode to be verified.
 * @property {boolean} includeFloatDefaults Whether to include float defaults, e.g., bonus amounts
 * @property {boolean} includeCreatingUserId Whether to include the creating user ID. Not available on query calls 
 */
module.exports.verify = async (event) => {
    try {
        if (opsUtil.isWarmup(event)) {
            logger('Referral verify warmup');
            return { result: 'WARMED' };
        }
        // todo : validation of request
        const params = opsUtil.extractParamsFromEvent(event);
        logger('Referral verification params: ', params);
        if (!params.referralCode || typeof params.referralCode !== 'string' || params.referralCode.trim().length === 0) {
            return { statusCode: status['Not Found'], body: JSON.stringify({ result: 'NO_CODE_PROVIDED' })};
        }
        
        const referralCode = params.referralCode.toUpperCase().trim();
        
        const colsToReturn = [...standardCodeColumns];
        if (params.includeCreatingUserId && !Reflect.has(event, 'httpMethod')) {
            colsToReturn.push('creatingUserId');
        }

        const tableLookUpResult = await fetchReferralCodeDetails(referralCode, params.countryCode, colsToReturn);

        logger('Table lookup result: ', tableLookUpResult);
        if (opsUtil.isObjectEmpty(tableLookUpResult)) {
            return { statusCode: status['Not Found'], body: JSON.stringify({ result: 'CODE_NOT_FOUND' })};
        }
        
        const codeDetails = tableLookUpResult;
        if (params.includeFloatDefaults) {
            const { clientId, floatId } = tableLookUpResult;
            codeDetails.floatDefaults = await fetchUserReferralDefaults(clientId, floatId);
        }
        
        logger('Returning lookup result: ', codeDetails);
        return { statusCode: status['OK'], body: JSON.stringify({ result: 'CODE_IS_ACTIVE', codeDetails })};
    } catch (e) {
        return handleErrorAndReturn(e);
    }
};

const createAudienceConditions = (boostUserIds) => ({ conditions: [{ op: 'in', prop: 'systemWideUserId', value: boostUserIds }]});

const referralHasZeroRedemption = (referralContext) => {
    const { boostAmountOffered } = referralContext;
    if (typeof boostAmountOffered === 'object') {
        return opsUtil.isObjectEmpty(boostAmountOffered) || boostAmountOffered.amount === 0;
    }
    
    if (!boostAmountOffered || typeof boostAmountOffered !== 'string') {
        logger('Boost amount offered must be malformed: ', referralContext.boostAmountOffered);
        return true;
    }

    const splitAmount = parseInt(boostAmountOffered.split('::'), 10);
    if (!splitAmount || typeof splitAmount !== 'number' || splitAmount === 0) {
        logger('No boost amount offered at all, return true');
        return true;
    }

    return false;
};

const fetchUserProfile = async (systemWideUserId) => {
    const relevantProfileColumns = [
        'system_wide_user_id',
        'called_name',
        'personal_name',
        'family_name',
        'client_id', 
        'float_id', 
        'referral_code_used', 
        'country_code', 
        'creation_time_epoch_millis'
    ];

    logger('Fetching profile for user id: ', systemWideUserId);
    const userProfile = await dynamo.fetchSingleRow(config.get('tables.userProfile'), { systemWideUserId }, relevantProfileColumns);
    logger('Got user profile: ', userProfile);

    if (!userProfile) {
        throw new Error(`Error! No profile found for: ${systemWideUserId}`);
    }

    return userProfile;
};

const updateProfileReferralCode = async (systemWideUserId, referralCodeUsed) => {
    const updateParams = {
        tableName: config.get('tables.userProfile'),
        itemKey: { systemWideUserId },
        updateExpression: 'set referral_code_used = :rcu',
        substitutionDict: { ':rcu': referralCodeUsed },
        returnOnlyUpdated: true
    };

    try {
        const resultOfUpdate = await dynamo.updateRow(updateParams);
        logger('Result of update: ', JSON.stringify(resultOfUpdate));
        return { result: 'SUCCESS' };
    } catch (err) {
        logger('Error updating user profile referral code: ', err);
        throw new Error(err.message);
    }
};

const fetchReferralContext = async (referralCodeDetails) => {
    if (referralCodeDetails.codeType === 'USER') {
        const { clientId, floatId } = referralCodeDetails;
        return fetchUserReferralDefaults(clientId, floatId);
    }

    return referralCodeDetails.context;
};

// Here the user using the code (referred user) is logged as the initator and the referrring user is used as the user id key
const publishReferralCodeEvent = async (referredUserProfile, referralCodeDetails, referralContext) => {
    const referredUserId = referredUserProfile.systemWideUserId;
    const referringUserId = referralCodeDetails.creatingUserId;

    // as above
    const { boostAmountOffered } = referralContext;
    const boostAmountPerUser = typeof boostAmountOffered === 'string' ? opsUtil.convertAmountStringToDict(boostAmountOffered) : boostAmountOffered; 
    const referralAmountForUser = opsUtil.convertToUnit(boostAmountPerUser.amount, boostAmountPerUser.unit, 'WHOLE_CURRENCY');
     
    const logOptions = {
        initiator: referredUserId,
        context: {
            referralContext,
            referralAmountForUser,
            referralCode: referralCodeDetails.referralCode,
            refCodeCreationTime: referralCodeDetails.persistedTimeMillis,
            referredUserCreationTime: referredUserProfile.creationTimeEpochMillis,
            referredUserCalledName: referredUserProfile.calledName || referredUserProfile.personalName
        }
    };

    logger('Publishing referral event with log options: ', logOptions);
    await publisher.publishUserEvent(referringUserId, 'REFERRAL_CODE_USED', logOptions);
};

const publishEventAndUpdateProfile = async (userProfile, referralContext, referralCodeDetails) => {
    const resultOfUpdate = await updateProfileReferralCode(userProfile.systemWideUserId, referralCodeDetails.referralCode);
    logger('Profile update result: ', resultOfUpdate);

    await publishReferralCodeEvent(userProfile, referralCodeDetails, referralContext);
};

const assembleStatusConditions = (referredUserId, referralContext) => {
    const { redeemConditionType, redeemConditionAmount, daysToMaintain } = referralContext;
    
    const referralRevokeDays = daysToMaintain ? daysToMaintain : config.get('revocationDefaults.withdrawalTime');
    const referralRevokeLimit = moment().add(referralRevokeDays, 'days').valueOf();

    const statusConditions = {
        REDEEMED: [`save_completed_by #{${referredUserId}}`],
        REVOKED: [`withdrawal_before #{${referralRevokeLimit}}`]
    };

    const { amount, unit, currency } = redeemConditionAmount;
    if (redeemConditionType === 'SIMPLE_SAVE') {
        statusConditions.REDEEMED.push(`first_save_above #{${amount}::${unit}::${currency}}`);
    }

    if (redeemConditionType === 'TARGET_BALANCE') {
        statusConditions.REDEEMED.push(`balance_crossed_abs_target #{${amount}::${unit}::${currency}}`);
    }

    return statusConditions;
};

const canUserUseCode = async (referralCodeDetails, referredUserProfile) => {
    if (referralCodeDetails.referralCode === referredUserProfile.referralCodeUsed) {
        logger('Referral code has already been used, exiting');
        return false;
    }

    if (referralCodeDetails.persistedTimeMillis > referredUserProfile.creationTimeEpochMillis) {
        logger('Referral code younger than referred user, exiting');
        return false;
    }

    const cutOffMoment = moment().subtract(config.get('userCodeCutOff.value'), config.get('userCodeCutOff.unit'));
    if (moment(referredUserProfile.creationTimeEpochMillis).isBefore(cutOffMoment)) {
        logger('User is too old, exiting');
        return false;
    }

    if (referredUserProfile.referralCodeUsed && referredUserProfile.referralCodeUsed !== referralCodeDetails.referralCode) {
        const previousReferralCodeDetails = await fetchReferralCodeDetails(referredUserProfile.referralCodeUsed, referredUserProfile.countryCode, standardCodeColumns);
        logger('Got details of previously used referral code: ', previousReferralCodeDetails);
        if (!['BETA', 'CHANNEL'].includes(previousReferralCodeDetails.codeType) && referralCodeDetails.codeType === 'USER') {
            logger('Referral code is out of sequence, exiting');
            return false;
        }
    }

    return true;
};

const triggerBoostForReferralCode = async (userProfile, referralCodeDetails, boostParameters) => {
    logger('Assembling referral code with bonus details: ', boostParameters);

    const referredUserId = userProfile.systemWideUserId;
    const boostUserIds = [referredUserId];

    const referralType = referralCodeDetails.codeType;
    const boostCategory = `${referralType}_CODE_USED`;
    
    const redemptionMsgInstructions = [{ systemWideUserId: referredUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' }];

    const { boostAmountOffered, bonusPoolId } = boostParameters;
    // a bit nasty but grandfathering in a change, so
    const boostAmountPerUser = typeof boostAmountOffered === 'string' ? opsUtil.convertAmountStringToDict(boostAmountOffered) : boostAmountOffered; 

    if (referralType === 'USER') {
        const referringUserId = referralCodeDetails.creatingUserId;
        redemptionMsgInstructions.push({ systemWideUserId: referringUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' });
        boostUserIds.push(referringUserId);
    }

    const boostAudienceSelection = createAudienceConditions(boostUserIds);
    // time within which the new user has to save in order to claim the bonus
    const bonusExpiryTime = moment().add(config.get('revocationDefaults.expiryTimeDays'), 'days');
    const statusConditions = assembleStatusConditions(referredUserId, boostParameters);
    logger('Assembled status conditions: ', statusConditions);

    const boostPayload = {
        creatingUserId: referredUserId,
        label: `User referral code`,
        boostTypeCategory: `REFERRAL::${boostCategory}`,
        boostAmountOffered: opsUtil.convertAmountDictToString(boostAmountPerUser),
        boostBudget: boostAmountPerUser.amount * boostUserIds.length,
        boostSource: {
            clientId: userProfile.clientId,
            floatId: userProfile.floatId,
            bonusPoolId
        },
        endTimeMillis: bonusExpiryTime.valueOf(),
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection,
        initialStatus: 'PENDING',
        statusConditions,
        messageInstructionFlags: {
            'REDEEMED': redemptionMsgInstructions
        }
    };

    const lambdaInvocation = {
        FunctionName: config.get('lambda.createBoost'),
        InvocationType: 'Event',
        Payload: JSON.stringify(boostPayload)
    };

    logger('Invoking lambda with payload: ', boostPayload);
    const resultOfTrigger = await lambda.invoke(lambdaInvocation).promise();
    logger('Result of firing off lambda invoke: ', resultOfTrigger);

    const codeBoostDetails = boostParameters;
    codeBoostDetails.boostEndTimeMillis = bonusExpiryTime.valueOf();

    if (referralType === 'USER') {
        const [referringUser] = await Promise.all([
            await fetchUserProfile(referralCodeDetails.systemWideUserId),
            await publishEventAndUpdateProfile(userProfile, boostParameters, referralCodeDetails)
        ]);
        codeBoostDetails.codeOwnerName = referringUser.calledName || referringUser.personalName;
    }

    return { result: 'BOOST_CREATED', codeBoostDetails };
};

const getUserOwnReferralData = async (userProfile) => {
    const { creationTimeEpochMillis, referralCodeUsed, countryCode } = userProfile;
    
    const hasUsedReferralCode = typeof referralCodeUsed === 'string' && referralCodeUsed.length > 0;
    const cutOffMoment = moment().subtract(config.get('userCodeCutOff.value'), config.get('userCodeCutOff.unit'));
    const isUserRecent = moment(creationTimeEpochMillis).isAfter(cutOffMoment);
    logger('Is user recent enough to use a code? : ', isUserRecent, ' cut off: ', cutOffMoment, ' and use: ', moment(creationTimeEpochMillis));

    if (!hasUsedReferralCode) {
        return { hasUsedReferralCode, canUseReferralCode: isUserRecent };
    }

    const usedCodeDetails = await fetchReferralCodeDetails(referralCodeUsed, countryCode, ['codeType']);
    const canUseReferralCode = isUserRecent && usedCodeDetails.codeType !== 'USER';
    return { hasUsedReferralCode, canUseReferralCode };
};

const getBoostOfferForUserCode = async (userProfile) => {
    const { clientId, floatId } = userProfile;
    const userReferralDefaults = await fetchUserReferralDefaults(clientId, floatId);

    if (referralHasZeroRedemption(userReferralDefaults)) {
        return { boostOnOffer: false };
    }

    const referralBonusData = {
        boostAmountOffered: userReferralDefaults.boostAmountOffered,
        redeemConditionAmount: userReferralDefaults.redeemConditionAmount,
        daysToMaintain: userReferralDefaults.daysToMaintain
    };

    return { boostOnOffer: true, referralBonusData };
};

const assembleReferralData = async (userProfile) => {
    const [{ hasUsedReferralCode, canUseReferralCode }, { boostOnOffer, referralBonusData }] = await Promise.all([
        getUserOwnReferralData(userProfile), getBoostOfferForUserCode(userProfile)
    ]);
    
    return { hasUsedReferralCode, canUseReferralCode, boostOnOffer, referralBonusData };
};

// this handles redeeming a referral code, if it is present and includes an amount
// the method will create a boost in 'PENDING', triggered when the referred user saves
module.exports.useReferralCode = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'referredUserId')) {
            return { statusCode: status('Forbidden') };
        }
    
        const userDetails = opsUtil.extractUserDetails(event);
        const params = opsUtil.extractParamsFromEvent(event);

        const referredUserId = params.referredUserId || userDetails.systemWideUserId;
        const { referralCodeUsed } = opsUtil.extractParamsFromEvent(event);
        logger('Got referral code: ', referralCodeUsed, 'And referred user id: ', referredUserId);

        const userProfile = await fetchUserProfile(referredUserId);
        
        // this is for getting details about boost on offer, etc.
        // note : "status" would in theory be a better place for this, but then would have complexity with authorizer optionality
        // and this will only be used right before the "use" call, hence
        if (!referralCodeUsed && params.obtainReferralData) {
            const referralData = await assembleReferralData(userProfile);
            return opsUtil.wrapResponse(referralData);
        }
    
        const relevantColumns = ['creatingUserId', ...standardCodeColumns];
        const referralCodeDetails = await fetchReferralCodeDetails(referralCodeUsed, userProfile.countryCode, relevantColumns);
        
        if (!referralCodeDetails || Object.keys(referralCodeDetails).length === 0) {
            logger('No referral code details provided, exiting');
            return opsUtil.wrapResponse({ result: 'CODE_NOT_FOUND' });
        }

        const validReferralCode = await canUserUseCode(referralCodeDetails, userProfile);
        if (!validReferralCode) {
            return opsUtil.wrapResponse({ result: 'USER_CANNOT_USE' });
        }

        const referralContext = await fetchReferralContext(referralCodeDetails);
        if (!referralContext) {
            logger('No referral context to give boost amount etc, set code and exit');
            await updateProfileReferralCode(referredUserId, referralCodeUsed);
            return opsUtil.wrapResponse({ result: 'CODE_SET_NO_BOOST' });
        }
    
        if (referralHasZeroRedemption(referralContext)) {
            logger('Referral context but amount offered is zero, exiting');
            await updateProfileReferralCode(referredUserId, referralCodeUsed);
            return opsUtil.wrapResponse({ result: 'CODE_SET_NO_BOOST' });
        }

        const resultOfTrigger = await triggerBoostForReferralCode(userProfile, referralCodeDetails, referralContext);
        return opsUtil.wrapResponse(resultOfTrigger);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};
