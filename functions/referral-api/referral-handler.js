'use strict';

const logger = require('debug')('jupiter:referral:handler');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const randomWord = require('random-words');
const camelCaseKeys = require('camelcase-keys');

const dynamo = require('dynamo-common');
const authUtil = require('auth-util-common');

const END_OF_TIME_YEAR = 2050;

const handleErrorAndReturn = (e) => {
    logger('FATAL_ERROR: ', e);
    return { statusCode: 500, body: JSON.stringify(e.message) };
};

const isCodeAvailable = async (referralCode) => {
    const codeExistsTest = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { referralCode }, ['referralCode']);
    return authUtil.isObjectEmpty(codeExistsTest);
};

const generateUnusedCode = async () => {
    logger('No referral code passed, so need to generate one randomly');
    let attemptedWord = null;
    let unusedWordFound = false;
    while (!unusedWordFound) {
        attemptedWord = randomWord().toUpperCase().trim();
        logger('Trying this word: ', attemptedWord);
        const codeExistsTest = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { referralCode: attemptedWord }, ['referralCode']);
        unusedWordFound = authUtil.isObjectEmpty(codeExistsTest);
    }

    return attemptedWord; 
};

/**
 * Sets the referral context, itself used for things like boosts based on the code
 * NOTE : on reflection, we are _not_ normalizing this so that client-float referral details are pulled from its tables on each
 * use, because that would impose a trade-off between updating referral-boost details for future users and having to communicate
 * it to existing users. As it is, future users can have boost from their referral code adjusted, while prior ones do not  
 * @param {object} params The params passed into the parent function. Must have float ID and client ID. Can have boost details in
 * requestContext, otherwise for user referral codes they will be drawn from the client-float defaults. If they are passed in, require:
 * @property {string} boostAmountOffered In our standard pattern of amount::unit::currency
 * @property {string} boostSource A client ID, a floatID, and a bonus pool Id 
 */
const defineReferralContext = async (params) => {
    const clientFloatKey = { floatId: params.floatId, clientId: params.clientId };

    // if referral context is provided, just make sure client & float are in there and return it
    if (!authUtil.isObjectEmpty(params.referralContext)) {
        return { ...clientFloatKey, ...params.referralContext };
    }
    
    // if nothing provided, and it's a user code, we draw from the defaults
    if (params.codeType === 'USER') {
        const referralContext = { ...clientFloatKey };
        
        const clientFloatVars = await dynamo.fetchSingleRow(config.get('tables.clientFloatTable'), clientFloatKey);
        
        logger('Received from client float vars: ', clientFloatVars);
        logger('Referral defaults :', clientFloatVars.userReferralDefaults);

        if (!authUtil.isObjectEmpty(clientFloatVars.userReferralDefaults)) {
            const referralBoostDetails = camelCaseKeys(clientFloatVars.userReferralDefaults);
            logger('Referral details: ', referralBoostDetails);
            referralContext.boostAmountOffered = referralBoostDetails.boostAmountEach;
            referralContext.boostSource = { ...clientFloatKey, bonusPoolId: referralBoostDetails.fromBonusPoolId};
        }
        return referralContext;
    }

    return clientFloatKey;
};

const updateUserProfile = async (systemWideUserId, referralCode) => {
    const dynamoUpdateParams = {
        tableName: config.get('tables.userProfile'),
        itemKey: { systemWideUserId },
        updateExpression: 'set referral_code = :rc',
        substitutionDict: { ':rc': referralCode },
        returnOnlyUpdated: true
    };

    const resultOfUpdate = await dynamo.updateRow(dynamoUpdateParams);
    logger('Result of profile update: ', resultOfUpdate);
};

/**
 * @param {object} event An event objet containing a referral code, code type, the system wide id of its creator, and its expiry time in millieseconds.
 * @property {string} referralCode The referral code.
 * @property {string} codeType The code type.
 * @property {string} creatingUserId The system wide id of the referrals creator.
 * @property {string} expiryTimeMillis When the referral code should expire.
 */
module.exports.create = async (event) => {
    try {
        // todo : validation of e.g., only system admin can open non-user referral codes
        
        logger('Referral creation event: ', event);
        const params = authUtil.extractParamsFromEvent(event);
        
        let codeToCreate = '';
        
        if (params.referralCode) {
            codeToCreate = params.referralCode.toUpperCase().trim();
            const isCodeFree = await isCodeAvailable(codeToCreate);
            if (!isCodeFree) {
                logger('Code exists, returning error');
                return { statusCode: status['Conflict'], body: JSON.stringify({ result: 'CODE_ALREADY_EXISTS' })};
            }
        } else {
            codeToCreate = await generateUnusedCode(params);
            logger('Generated random word: ', codeToCreate);
        }

        logger('Transformed referral code: ', codeToCreate);    
        
        const rowToInsert = {
            referralCode: codeToCreate,
            codeType: params.codeType,
            creatingUserId: params.creatingUserId,
            persistedTimeMillis: moment().valueOf(),
            expiryTimeMillis: params.expiryTimeMillis
        };

        if (params.codeType === 'USER' && !params.expiryTimeMillis) {
            logger('User code being created, no expiry time, setting to distant future');
            rowToInsert.expiryTimeMillis = moment([END_OF_TIME_YEAR, 0, 1]).valueOf();
        }
        
        rowToInsert.context = await defineReferralContext(params);

        logger('Row being inserted: ', rowToInsert);
        
        const insertionResult = await dynamo.insertNewRow(config.get('tables.activeCodes'), ['referralCode'], rowToInsert);

        if (insertionResult && insertionResult.result === 'SUCCESS') {
            if (params.codeType === 'USER') {
                logger('Referral code is for a user, updating their profile');
                await updateUserProfile(params.creatingUserId, codeToCreate);
            }
            return { statusCode: status['OK'], body: JSON.stringify({ persistedTimeMillis: rowToInsert.persistedTimeMillis })};
        } 
        
        logger('Strange insertion error: ', insertionResult);
        throw new Error('Unknown error, check logs for insertion error');
    } catch (e) {
        return handleErrorAndReturn(e);
    }
};

/**
 * This function verifies a referral code.
 * @param {object} event An event object containing the referral code to be evaluated.
 * @property {string} referralCode The referralCode to be verified.
 */
module.exports.verify = async (event) => {
    try {
        if (authUtil.isWarmup(event)) {
            logger('Referral verify warmup');
            return authUtil.warmUpResponse;
        }
        // todo : validation of request
        const params = authUtil.extractParamsFromEvent(event);
        logger('Referral verification params: ', params);
        const referralCode = params.referralCode.toUpperCase().trim();
        const colsToReturn = ['referralCode', 'codeType', 'expiryTimeMillis', 'context'];
        const tableLookUpResult = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { referralCode }, colsToReturn);
        logger('Table lookup result: ', tableLookUpResult);
        logger('Is this object empty? :', authUtil.isObjectEmpty(tableLookUpResult));
        if (authUtil.isObjectEmpty(tableLookUpResult)) {
            return { statusCode: status['Not Found'], body: JSON.stringify({ result: 'CODE_NOT_FOUND' })};
        } 
        
        logger('Returning lookup result');
        return { statusCode: status['OK'], body: JSON.stringify({ result: 'CODE_IS_ACTIVE', codeDetails: tableLookUpResult })};
    } catch (e) {
        return handleErrorAndReturn(e);
    }
};

/**
 * To be implemented: This function updates a referral code.
 */
module.exports.modify = async (event) => {
    try {
        logger('Referral update: ', event);
    } catch (e) {
        return handleErrorAndReturn(e);
    }
};
