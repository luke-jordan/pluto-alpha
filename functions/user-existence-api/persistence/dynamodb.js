'use strict';

const logger = require('debug')('jupiter:profile:dynamo');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const dynamoCommon = require('dynamo-common');

const nullIfEmptyElseSystemId = (itemFromDynamo) => {
    if (!itemFromDynamo || Object.keys(itemFromDynamo).length === 0) {
        return null;
    } 
    return itemFromDynamo.systemWideUserId;
};

// note: eventually use transactions to do rollback, most likely (but check the SDK, may be painful)
module.exports.insertUserProfile = async (userProfile) => {
    const doesIdExist = await exports.fetchUserByNationalId(userProfile.clientId, userProfile.nationalId);
    logger('User profile creation, is national ID taken? : ', doesIdExist !== null);
    if (doesIdExist !== null) {
        return { result: 'ERROR', message: 'NATIONAL_ID_TAKEN' };
    }

    // now we can create a system wide user id
    const systemWideUserId = uuid();

    const nationalIdRow = { countryCode: userProfile.countryCode, nationalId: userProfile.nationalId, systemWideUserId };
    const insertNationalId = await dynamoCommon.insertNewRow(config.get('tables.dynamo.nationalIdTable'), ['countryCode', 'nationalId'], nationalIdRow);
    logger('Result of inserting national ID: ', insertNationalId);
    if (!insertNationalId || insertNationalId.result !== 'SUCCESS') {
        return { result: 'ERROR', message: 'ERROR_INSERTING_NATIONAL_ID' };
    }

    const rowForTable = {
        systemWideUserId: systemWideUserId,
        clientId: userProfile.clientId,
        floatId: userProfile.defaultFloatId,
        defaultCurrency: userProfile.defaultCurrency,
        defaultTimezone: userProfile.defaultTimezone,
        personalName: userProfile.personalName,
        familyName: userProfile.familyName,
        countryCode: userProfile.countryCode,
        nationalId: userProfile.nationalId,
        userStatus: userProfile.userStatus,
        kycStatus: userProfile.kycStatus,
        userRole: userProfile.userRole || 'ORDINARY_MEMBER',
        securedStatus: userProfile.passwordSet ? 'PASSWORD_SET' : 'NO_PASSWORD'
    };

    // todo: what do we do if the national ID goes fine but the phone number is taken and there is no email [ answer : we should reverse it all ]
    if (userProfile.primaryPhone) {
        const doesPhoneExist = await exports.fetchUserByPhone(userProfile.primaryPhone);
        if (doesPhoneExist === null) {
            const phoneNumberRow = { phoneNumber: userProfile.primaryPhone, systemWideUserId };
            const insertPhoneResult = await dynamoCommon.insertNewRow(config.get('tables.dynamo.phoneTable'), ['phoneNumber'], phoneNumberRow);
            if (insertPhoneResult.result === 'SUCCESS') {
                rowForTable.phoneNumber = userProfile.primaryPhone;
            } else {
                return { result: 'ERROR', message: 'PHONE_NUMBER_ERROR' };
            }
        } else {
            return { result: 'ERROR', message: 'PHONE_NUMBER_TAKEN' };
        }
    }
    
    if (userProfile.primaryEmail) {
        const doesEmailExist = await exports.fetchUserByEmail(userProfile.primaryEmail);
        if (doesEmailExist === null) {
            const emailRow = { emailAddress: userProfile.primaryEmail, systemWideUserId };
            const insertEmailResult = await dynamoCommon.insertNewRow(config.get('tables.dynamo.emailTable'), ['emailAddress'], emailRow);
            if (insertEmailResult.result === 'SUCCESS') {
                rowForTable.emailAddress = userProfile.emailAddress;
            } else {
                return { result: 'ERROR', message: 'EMAIL_ADDRESS_ERROR' };
            }
        } else {
            return { result: 'ERROR', message: 'EMAIL_ADDRESS_TAKEN' };
        }
    }

    // all seems okay, so we record the time that we are persisting the profile
    // todo : record creation time in the other tables too
    const creationTime = moment();
    rowForTable.creationTimeEpochMillis = creationTime.valueOf();
    rowForTable.updatedTimeEpochMillis = creationTime.valueOf();

    logger('Sending row to table: ', rowForTable);
    const resultOfInsertion = await dynamoCommon.insertNewRow(config.get('tables.dynamo.profileTable'), ['systemWideUserId'], rowForTable);
    logger('Result of inserting profile, from DynamoDB: ', resultOfInsertion);
    if (!resultOfInsertion || resultOfInsertion.result !== 'SUCCESS') {
        return { result: 'ERROR', message: 'FAILED_AT_LAST_HURDLE' };
    }
    
    return {
        result: 'SUCCESS',
        systemWideUserId: systemWideUserId,
        creationTimeEpochMillis: creationTime.valueOf()
    };
};


/**
 * todo: validation, lots
 * Updates a user's status field
 * Status field (in dict): 'SYSTEM_STATUS', 'KYC_STATUS', 'SECURED_STATUS'
 */
module.exports.updateUserStatus = async (systemWideUserId, statusDict) => {
    logger('Triggering an update of user');
    
    const expressionClauses = [];
    const expressionMap = { };

    if (statusDict.userStatus) {
        expressionClauses.push('user_status = :ust');
        expressionMap[':ust'] = statusDict.userStatus;
    }

    if (statusDict.kycStatus) {
        expressionClauses.push('kyc_status = :kst');
        expressionMap[':kst'] = statusDict.kycStatus;
    }

    if (statusDict.securedStatus) {
        expressionClauses.push('secured_status = :sst');
        expressionMap[':sst'] = statusDict.securedStatus;
    }

    if (expressionClauses.length === 0) {
        throw new Error('No valid updates passed to update method');
    }

    expressionClauses.push('updated_time_epoch_millis = :utime');
    expressionMap[':utime'] = moment().valueOf();

    const assembledClause = `set ${expressionClauses.join(', ')}`;
    const updateParams = {
        tableName: config.get('tables.dynamo.profileTable'),
        itemKey: { systemWideUserId },
        updateExpression: assembledClause,
        substitutionDict: expressionMap,
        returnOnlyUpdated: true
    };

    try {
        logger('Passing to Dynamo: ', updateParams);
        const resultOfUpdate = await dynamoCommon.updateRow(updateParams);
        // logger('Received from Dynamo: ', resultOfUpdate);
        return { result: 'SUCCESS', updatedTimeEpochMillis: resultOfUpdate.returnedAttributes.updatedTimeEpochMillis };
    } catch (err) {
        logger('Error updating row in Dynamo: ', err);
        logger('Was passed status update dict: ', statusDict);
        logger('Assembled expression: ', assembledClause);
        throw err;
    }
};

module.exports.updateUserLastLogin = async (systemWideUserId, lastLoginTimeMillis) => {
    if (!Number.isInteger(lastLoginTimeMillis)) {
        throw new TypeError('Error! Last login time must be in millis');
    }

    const updateParams = {
        tableName: config.get('tables.dynamo.profileTable'),
        itemKey: { systemWideUserId },
        updateExpression: 'set last_login_time_millis = :llt',
        substitutionDict: { ':llt': lastLoginTimeMillis },
        returnOnlyUpdated: true
    };

    try {
        const resultOfUpdate = await dynamoCommon.updateRow(updateParams);
        return { result: 'SUCCESS', lastLoginTimeMillis: resultOfUpdate.returnedAttributes.lastLoginTimeMillis };
    } catch (err) {
        logger('Error updating last login time, error details: ', err);
        throw err;
    }
};

module.exports.updateUserProfile = async (systemWideUserId, updateParams) => {
    logger('Not built yet, but would update: ', systemWideUserId, ' according to instruction: ', updateParams);
    throw new Error('Not built yet');
};

module.exports.fetchUserProfile = async (systemWideUserId) => {
    logger('Seeking user with system ID: ', systemWideUserId);
    const itemFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamo.profileTable'), { systemWideUserId });
    logger('Back from Dynamo: ', itemFromDynamo);
    return !itemFromDynamo || Object.keys(itemFromDynamo).length === 0 ? null : itemFromDynamo;
};

module.exports.fetchUserByNationalId = async (countryCode, nationalId) => {
    logger('Seeking a user with national ID: ', nationalId);
    const itemFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamo.nationalIdTable'), { countryCode, nationalId });
    return nullIfEmptyElseSystemId(itemFromDynamo);
};

module.exports.fetchUserByPhone = async (phoneNumber) => {
    logger('Seeking a user with phone number: ', phoneNumber);
    const itemFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamo.phoneTable'), { phoneNumber });
    return nullIfEmptyElseSystemId(itemFromDynamo);
};

module.exports.fetchUserByEmail = async (emailAddress) => {
    logger('Seeking a user with email address: ', emailAddress);
    const itemFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamo.emailTable'), { emailAddress });
    return nullIfEmptyElseSystemId(itemFromDynamo);
};
