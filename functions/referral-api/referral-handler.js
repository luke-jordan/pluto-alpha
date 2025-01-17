'use strict';

const logger = require('debug')('jupiter:referral:handler');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const randomWord = require('random-words');
const camelCaseKeys = require('camelcase-keys');

const dynamo = require('dynamo-common');
const opsUtil = require('ops-util-common');

const END_OF_TIME_YEAR = 2050;

const handleErrorAndReturn = (e) => {
    logger('FATAL_ERROR: ', e);
    return { statusCode: 500, body: JSON.stringify(e.message) };
};

const isCodeAvailable = async (referralCode, countryCode) => {
    const codeExistsTest = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { referralCode, countryCode }, ['referralCode']);
    return opsUtil.isObjectEmpty(codeExistsTest);
};

const generateUnusedCode = async (countryCode) => {
    logger('No referral code passed, so need to generate one randomly, including two digits for the day');
    let attemptedWord = null;
    let unusedWordFound = false;
    while (!unusedWordFound) {
        attemptedWord = `${randomWord().toUpperCase().trim()}${moment().format('DD')}`;
        logger('Trying this word: ', attemptedWord);
        const codeExistsTest = await dynamo.fetchSingleRow(config.get('tables.activeCodes'), { countryCode, referralCode: attemptedWord }, ['referralCode']);
        unusedWordFound = opsUtil.isObjectEmpty(codeExistsTest);
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
 * @property {string} bonusPoolId Where the bonus is funded from 
 */
const defineReferralContext = async (params) => {
    const clientFloatKey = { floatId: params.floatId, clientId: params.clientId };

    // if referral context is provided, just make sure client & float are in there and return it
    if (!opsUtil.isObjectEmpty(params.referralContext)) {
        return params.referralContext;
    }
    
    // if nothing provided, and it's a user code, we draw from the defaults
    if (params.codeType === 'USER') {
        const referralContext = { };
        
        const clientFloatVars = await dynamo.fetchSingleRow(config.get('tables.clientFloatTable'), clientFloatKey);
        
        logger('Received from client float vars: ', clientFloatVars);
        logger('Referral defaults :', clientFloatVars.userReferralDefaults);

        if (!opsUtil.isObjectEmpty(clientFloatVars.userReferralDefaults)) {
            const referralBoostDetails = camelCaseKeys(clientFloatVars.userReferralDefaults);
            logger('Referral details: ', referralBoostDetails);
            referralContext.boostAmountOffered = referralBoostDetails.boostAmountEach;
            referralContext.bonusPoolId = referralBoostDetails.fromBonusPoolId;
            referralContext.shareLink = referralBoostDetails.shareLink;
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
 * Method to find out at present if referral codes are required for the country, and/or obtain a default
 * @param {object} event Standard event object
 * @property {string} countyCode The country in reference
 */
module.exports.status = async (event) => {
    try {
        const params = opsUtil.extractQueryParams(event);
        logger('Received params: ', params);
        const { countryCode } = params;
        logger('Return for country code: ', countryCode);
        const defaultCode = config.has('defaultCode') ? config.get('defaultCode') : '';
        const result = { codeRequired: true, defaultCode };
        return { statusCode: status['OK'], body: JSON.stringify(result) };
    } catch (err) {
        return handleErrorAndReturn(err);
    }
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
        
        logger('Referral creation initiated');
        const params = opsUtil.extractParamsFromEvent(event);
        logger('Referral parameters: ', params);
        
        const { countryCode } = params;
        
        let codeToCreate = '';
        
        if (params.referralCode) {
            codeToCreate = params.referralCode.toUpperCase().trim();
            const isCodeFree = await isCodeAvailable(codeToCreate, countryCode);
            if (!isCodeFree) {
                logger('Code exists, returning error');
                return { statusCode: status['Conflict'], body: JSON.stringify({ result: 'CODE_ALREADY_EXISTS' })};
            }
        } else {
            codeToCreate = await generateUnusedCode(countryCode);
            logger('Generated random word: ', codeToCreate);
        }

        logger('Transformed referral code: ', codeToCreate);    
        
        const rowToInsert = {
            countryCode,
            referralCode: codeToCreate,
            codeType: params.codeType,
            creatingUserId: params.creatingUserId,
            clientId: params.clientId,
            floatId: params.floatId,
            clientIdFloatId: `${params.clientId}::${params.floatId}`,
            persistedTimeMillis: moment().valueOf(),
            expiryTimeMillis: params.expiryTimeMillis
        };

        if (params.codeType === 'USER' && !params.expiryTimeMillis) {
            logger('User code being created, no expiry time, setting to distant future');
            rowToInsert.expiryTimeMillis = moment([END_OF_TIME_YEAR, 0, 1]).valueOf();
        }
        
        rowToInsert.context = await defineReferralContext(params);

        if (Array.isArray(params.tags) && params.tags.length > 0) {
            rowToInsert.tags = params.tags;
        }

        logger('Row being inserted: ', rowToInsert);
        
        const insertionResult = await dynamo.insertNewRow(config.get('tables.activeCodes'), ['referralCode'], rowToInsert);
        logger('Insertion result: ', insertionResult);

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

const deactivateCode = async (countryCode, referralCode, deactivatingUserId) => {
    const activeTable = config.get('tables.activeCodes');
    const archiveTable = config.get('tables.archivedCodes');

    const existingCode = await dynamo.fetchSingleRow(activeTable, { countryCode, referralCode });
    if (!existingCode) {
        return { result: 'NOSUCHCODE' };
    }

    const archivedCode = {
        referralCode,
        deactivatedTime: moment().valueOf(),
        countryCode,
        deactivatingUserId,
        archivedCode: existingCode
    };

    const resultOfInsert = await dynamo.insertNewRow(archiveTable, ['referralCode', 'deactivatedTime'], archivedCode);
    logger('Result of archive insertion: ', resultOfInsert);
    if (!resultOfInsert || resultOfInsert.result !== 'SUCCESS') {
        throw new Error('Error archiving code: ', JSON.stringify(resultOfInsert));
    }

    const deleteParams = {
        tableName: activeTable,
        itemKey: { countryCode, referralCode }
    };

    const resultOfDelete = await dynamo.deleteRow(deleteParams);
    logger('Result of deleting: ', resultOfDelete);
    if (!resultOfDelete || resultOfDelete.result !== 'DELETED') {
        throw new Error('Error deleting code: ', JSON.stringify(resultOfDelete));
    }

    return { result: 'DEACTIVATED' };
};

const modifyCode = async (params) => {
    const expressionClauses = [];
    const substitutionDict = { };

    const { newContext, tags } = params;
    if (newContext && newContext.boostAmountOffered) {
        expressionClauses.push('context.boostAmountOffered = :bamount');
        substitutionDict[':bamount'] = newContext.boostAmountOffered;
    }

    if (newContext && newContext.bonusPoolId) {
        expressionClauses.push('context.bonusPoolId = :bsource');
        substitutionDict[':bsource'] = newContext.bonusPoolId;
    }
    
    if (tags) {
        expressionClauses.push('tags = :rts');
        substitutionDict[':rts'] = tags;
    }

    if (expressionClauses.length === 0) {
        throw new Error('No valid properties to update');
    }

    const updateExpression = `set ${expressionClauses.join(', ')}`;
    
    const updateParams = {
        tableName: config.get('tables.activeCodes'),
        itemKey: { countryCode: params.countryCode, referralCode: params.referralCode },
        updateExpression,
        substitutionDict,
        returnOnlyUpdated: false
    };

    const resultOfUpdate = await dynamo.updateRow(updateParams);
    logger('Result of update: ', resultOfUpdate);
    if (!resultOfUpdate || resultOfUpdate.result !== 'SUCCESS') {
        throw new Error('Error updating: ', JSON.stringify(resultOfUpdate));
    }

    return { result: 'UPDATED', updatedCode: resultOfUpdate.returnedAttributes };
};

/**
 * This function modifies a referral code, either deactivating it or updating certain properties. Only called directly so no wrapping.
 */
module.exports.modify = async (event) => {
    try {

        logger('Referral update: ', event);
        const { operation, countryCode, referralCode, initiator } = event;
        if (['DEACTIVATE', 'UPDATE'].indexOf(operation) < 0) {
            throw new Error('Unsupported modification');
        }

        let result = { };        
        if (operation === 'DEACTIVATE') {
            result = await deactivateCode(countryCode, referralCode, initiator);
        } else if (operation === 'UPDATE') {
            result = await modifyCode(event);
        }

        if (opsUtil.isObjectEmpty(result)) {
            throw new Error('Reached end without result');
        }

        return result;

    } catch (error) {
        logger('FATAL_ERROR: ', error);
        return { result: 'ERROR', error };
    }
};
