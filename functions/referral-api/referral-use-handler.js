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
    logger('Got user referral defaults: ', tableLookUpResult);

    if (!tableLookUpResult) {
        return null;
    }

    return tableLookUpResult.userReferralDefaults;
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
            const userReferralDefaults = await fetchUserReferralDefaults(clientId, floatId);
            codeDetails.floatDefaults = camelCaseKeys(userReferralDefaults);
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
        return opsUtil.boostAmountOffered(referralContext) || boostAmountOffered.amount === 0;
    }
    
    if (!boostAmountOffered || typeof boostAmountOffered !== 'string') {
        logger('No boost amount offered at all, return true');
        return true;
    }

    const splitAmount = parseInt(referralContext.boostAmountOffered.split('::'), 10);
    if (!splitAmount || typeof splitAmount !== 'number' || splitAmount === 0) {
        logger('Boost amount offered must be malformed: ', referralContext.boostAmountOffered);
        return true;
    }

    return false;
};

const fetchUserProfile = async (systemWideUserId) => {
    const relevantProfileColumns = ['referral_code_used', 'country_code', 'creation_time_epoch_millis'];

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
        return { result: 'SUCCESS', referralCodeUsed: resultOfUpdate.returnedAttributes.referralCodeUsed };
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

    const [boostAmountOffered, fromUnit] = referralContext.boostAmountOffered.split('::');    
    const referralAmountForUser = opsUtil.convertToUnit(Number(boostAmountOffered), fromUnit, 'WHOLE_CURRENCY');
     
    const logOptions = {
        initiator: referredUserId,
        context: {
            referralContext,
            referralAmountForUser,
            referralCode: referralCodeDetails.referralCode,
            refCodeCreationTime: referralCodeDetails.persistedTimeMillis,
            referredUserCreationTime: referredUserProfile.creationTimeEpochMillis
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

const isValidReferralCode = async (referralCodeDetails, referredUserProfile) => {
    if (referralCodeDetails.referralCode === referredUserProfile.referralCodeUsed) {
        logger('Referral code has already been used, exiting');
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

    if (referralCodeDetails.persistedTimeMillis > referredUserProfile.creationTimeEpochMillis) {
        logger('Referral code older than referred user, exiting');
        return false;
    }

    return true;
};

const triggerBoostForReferralCode = async (userProfile, referralCodeDetails, referralContext) => {
    const referredUserId = userProfile.systemWideUserId;
    const boostUserIds = [referredUserId];

    const referralType = referralCodeDetails.codeType;
    const boostCategory = `${referralType}_CODE_USED`;
        
    const redemptionMsgInstructions = [{ systemWideUserId: referredUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' }];
    const amountArray = referralContext.boostAmountOffered.split('::');
    const boostAmountPerUser = amountArray[0];

    if (referralType === 'USER') {
        const referringUserId = referralCodeDetails.creatingUserId;
        redemptionMsgInstructions.push({ systemWideUserId: referringUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' });
        boostUserIds.push(referringUserId);
    }

    const boostAudienceSelection = createAudienceConditions(boostUserIds);
    // time within which the new user has to save in order to claim the bonus
    const bonusExpiryTime = moment().add(config.get('revocationDefaults.expiryTimeDays'), 'days');

    const statusConditions = assembleStatusConditions(referredUserId, referralContext);
    logger('Assembled status conditions: ', statusConditions);

    // a bit nasty but grandfathering in a change, so
    const boostAmountOffered = typeof referralContext.boostAmountOffered === 'object' 
        ? opsUtil.convertAmountDictToString(referralContext.boostAmountOffered) : referralContext.boostAmountOffered;

    // note : we may at some point want a "system" flag on creating user ID instead of the account opener, but for
    // now this will allow sufficient tracking, and a simple migration will fix it in the future    
    const boostPayload = {
        creatingUserId: referredUserId,
        label: `User referral code`,
        boostTypeCategory: `REFERRAL::${boostCategory}`,
        boostAmountOffered,
        boostBudget: boostAmountPerUser * boostUserIds.length,
        boostSource: referralContext.boostSource,
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

    if (referralType === 'USER') {
        await publishEventAndUpdateProfile(userProfile, referralContext, referralCodeDetails);
    }

    return { result: 'BOOST_TRIGGERED' };
};

// this handles redeeming a referral code, if it is present and includes an amount
// the method will create a boost in 'PENDING', triggered when the referred user saves
module.exports.useReferralCode = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: status('Forbidden') };
        }
    
        const { referralCodeUsed, referredUserId } = opsUtil.extractParamsFromEvent(event);
        logger('Got referral code: ', referralCodeUsed, 'And referred user id: ', referredUserId);

        const userProfile = await fetchUserProfile(referredUserId);
        logger('Got referred user profile ', userProfile);
    
        const relevantColumns = ['creatingUserId', ...standardCodeColumns];
        const referralCodeDetails = await fetchReferralCodeDetails(referralCodeUsed, userProfile.countryCode, relevantColumns);
        logger('Got referral code details: ', referralCodeDetails);
    
        if (!referralCodeDetails || Object.keys(referralCodeDetails).length === 0) {
            logger('No referral code details provided, exiting');
            return opsUtil.wrapResponse({ result: 'CODE_NOT_ALLOWED' });
        }

        const validReferralCode = await isValidReferralCode(referralCodeDetails, userProfile);
        if (!validReferralCode) {
            return opsUtil.wrapResponse({ result: 'CODE_NOT_ALLOWED' });
        }

        const referralContext = await fetchReferralContext(referralCodeDetails);
        if (!referralContext) {
            logger('No referral context to give boost amount etc, exiting');
            return opsUtil.wrapResponse({ result: 'CODE_NOT_ALLOWED' });
        }
    
        if (referralHasZeroRedemption(referralContext)) {
            logger('Referral context but amount offered is zero, exiting');
            return opsUtil.wrapResponse({ result: 'CODE_SET' });
        }

        const resultOfTrigger = await triggerBoostForReferralCode(userProfile, referralCodeDetails, referralContext);
        return opsUtil.wrapResponse(resultOfTrigger);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};
