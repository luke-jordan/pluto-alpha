'use strict';

const logger = require('debug')('jupiter:referral:handler');
const config = require('config');
const status = require('statuses');
const moment = require('moment');

const camelCaseKeys = require('camelcase-keys');

const dynamo = require('dynamo-common');
const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const handleErrorAndReturn = (e) => {
    logger('FATAL_ERROR: ', e);
    return { statusCode: 500, body: JSON.stringify(e.message) };
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
            return { statusCode: status['Not found'], body: JSON.stringify({ result: 'NO_CODE_PROVIDED' })};
        }
        
        const referralCode = params.referralCode.toUpperCase().trim();
        const codeKey = { referralCode, countryCode: params.countryCode };
        
        const colsToReturn = ['referralCode', 'codeType', 'expiryTimeMillis', 'context', 'clientId', 'floatId'];
        if (params.includeCreatingUserId && !Reflect.has(event, 'httpMethod')) {
            colsToReturn.push('creatingUserId');
        }

        const tableLookUpResult = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), codeKey, colsToReturn);
        
        logger('Table lookup result: ', tableLookUpResult);
        if (opsUtil.isObjectEmpty(tableLookUpResult)) {
            return { statusCode: status['Not Found'], body: JSON.stringify({ result: 'CODE_NOT_FOUND' })};
        }
        
        const codeDetails = tableLookUpResult;
        if (params.includeFloatDefaults) {
            const { clientId, floatId } = tableLookUpResult;
            const { userReferralDefaults } = await dynamo.fetchSingleRow(config.get('tables.clientFloatTable'), { clientId, floatId }, ['user_referral_defaults']);
            codeDetails.floatDefaults = camelCaseKeys(userReferralDefaults);
        }
        
        logger('Returning lookup result: ', codeDetails);
        return { statusCode: status['OK'], body: JSON.stringify({ result: 'CODE_IS_ACTIVE', codeDetails })};
    } catch (e) {
        return handleErrorAndReturn(e);
    }
};

const getReferralRevocationConditions = (referralContext) => {
    const referralRevokeDays = Reflect.has(referralContext, 'daysForRevocation') ? parseInt(referralContext.daysForRevocation, 10) 
        : parseInt(config.get('referral.withdrawalTime'), 10);
    const referralRevokeLimit = moment().subtract(referralRevokeDays, 'days').valueOf();
    const balanceLimit = Reflect.has(referralContext, 'balanceLimitForRevocation') ? referralContext.balanceLimitForRevocation 
        : config.get('referral.balanceBelow');
    return { referralRevokeLimit, balanceLimit };
};

// note : psql handles uuids without quotes (and that will throw an error without a uuid cast)
const createAudienceConditions = (boostUserIds) => ({
    table: config.get('tables.accountTable'),
    conditions: [{ op: 'in', prop: 'systemWideUserId', value: boostUserIds }]
});

const safeReferralAmountExtract = (referralContext, key = 'boostAmountOffered') => {
    if (!referralContext || typeof referralContext[key] !== 'string') {
        return 0;
    }
  
    const amountArray = referralContext[key].split('::');
    if (!amountArray || amountArray.length === 0) {
        return 0;
    }
  
    return amountArray[0];
};

const referralHasZeroRedemption = (referralContext) => {
    if (!referralContext.boostAmountOffered || typeof referralContext.boostAmountOffered !== 'string') {
        logger('No boost amount offered at all, return true');
        return true;
    }

    try {
        const splitAmount = parseInt(referralContext.boostAmountOffered.split('::'), 10);
        return splitAmount === 0;
    } catch (err) {
        logger('Boost amount offered must be malformed: ', err);
        return true;
    }
};

const fetchReferralCodeDetails = async (rawReferralCode, countryCode) => {
    if (!rawReferralCode || typeof rawReferralCode !== 'string') {
        return null;
    }

    const referralCode = rawReferralCode.toUpperCase().trim();
    logger('Verifying transformed referral code: ', referralCode);
    
    const referralCodeDetails = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { referralCode, countryCode });
    logger('Found referral code in table: ', referralCodeDetails);
    
    if (opsUtil.isObjectEmpty(referralCodeDetails)) {
        return null;
    }

    return referralCodeDetails;
};

const fetchUserProfile = async (systemWideUserId) => {
    const relevantProfileColumns = ['country_code'];

    logger('Fetching profile for user id: ', systemWideUserId);
    const userProfile = await dynamo.fetchSingleRow(config.get('tables.userProfile'), { systemWideUserId }, relevantProfileColumns);
    logger('Got user profile: ', userProfile);

    if (!userProfile) {
        throw new Error(`Error! No profile found for: ${systemWideUserId}`);
    }

    return userProfile;
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
    
        const referralCodeDetails = await fetchReferralCodeDetails(referralCodeUsed, userProfile.countryCode);
        logger('Got referral code details: ', referralCodeDetails);
    
        if (!referralCodeDetails || Object.keys(referralCodeDetails).length === 0) {
            logger('No referral code details provided, exiting');
            return { statusCode: status('Forbidden') };
        }
    
        const referralContext = referralCodeDetails.context;
        if (!referralContext) {
            logger('No referral context to give boost amount etc, exiting');
            return { statusCode: status('Forbidden') };
        }
    
        if (referralHasZeroRedemption(referralContext)) {
            logger('Referral context but amount offered is zero, exiting');
            return { statusCode: status('OK') };
        }
        
        const referralType = referralCodeDetails.codeType;
        const boostCategory = `${referralType}_CODE_USED`;
        
        const boostUserIds = [referredUserId];
        const redemptionMsgInstructions = [{ systemWideUserId: referredUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' }];
        const boostAmountPerUser = safeReferralAmountExtract(referralContext);
        
        if (referralType === 'USER') {
            const referringUserId = referralCodeDetails.creatingUserId;
            // todo: referring user validation
            redemptionMsgInstructions.push({ systemWideUserId: referringUserId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' });
            boostUserIds.push(referringUserId);
        }
    
        const boostAudienceSelection = createAudienceConditions(boostUserIds);
        // time within which the new user has to save in order to claim the bonus
        const bonusExpiryTime = moment().add(config.get('referral.expiryTimeDays'), 'days');
    
        const { balanceLimit, referralRevokeLimit } = getReferralRevocationConditions(referralContext);
    
        // note : we may at some point want a "system" flag on creating user ID instead of the account opener, but for
        // now this will allow sufficient tracking, and a simple migration will fix it in the future
        const boostPayload = {
            creatingUserId: referredUserId,
            label: `User referral code`,
            boostTypeCategory: `REFERRAL::${boostCategory}`,
            boostAmountOffered: referralContext.boostAmountOffered,
            boostBudget: boostAmountPerUser * boostUserIds.length,
            boostSource: referralContext.boostSource,
            endTimeMillis: bonusExpiryTime.valueOf(),
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection,
            initialStatus: 'PENDING',
            statusConditions: {
                'REDEEMED': [`save_completed_by #{${referredUserId}}`, `first_save_by #{${referredUserId}}`],
                'REVOKED': [`balance_below #{${balanceLimit}}`, `withdrawal_before #{${referralRevokeLimit}}`]
            },
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
    
        return { statusCode: status('OK'), body: JSON.stringify({ resultOfTrigger }) };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500 };
    }
};
