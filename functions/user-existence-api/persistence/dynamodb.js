'use strict';

const logger = require('debug')('jupiter:profile:dynamo');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const dynamoCommon = require('dynamo-common');

const nullIfEmptyElseSystemId = (itemFromDynamo) => Object.keys(itemFromDynamo).length === 0 ? null : { systemWideUserId: itemFromDynamo.systemWideUserId };

// note: eventually use transactions to do rollback, most likely (but check the SDK, may be painful)
module.exports.insertUserProfile = async (userProfile) => {
    const doesIdExist = await exports.fetchUserByNationalId(userProfile.clientId, userProfile.nationalId);
    logger('User profile creation, is national ID taken? : ', doesIdExist != null);
    if (doesIdExist !== null) {
        return { result: 'ERROR', message: 'NATIONAL_ID_TAKEN' };
    }

    // now we can create a system wide user id
    const systemWideUserId = uuid();

    const nationalIdRow = { clientId: userProfile.clientId, nationalId: userProfile.nationalId, systemWideUserId };
    const insertNationalId = await dynamoCommon.insertNewRow(config.get('tables.dynamo.nationalIdTable'), ['clientId', 'nationalId'], nationalIdRow);
    logger('Result of inserting national ID: ', insertNationalId);
    if (!insertNationalId || insertNationalId.result !== 'SUCCESS') {
        return { result: 'ERROR', message: 'ERROR_INSERTING_NATIONAL_ID' };
    }

    const rowForTable = {
        systemWideUserId: systemWideUserId,
        clientId: userProfile.clientId,
        floatId: userProfile.defaultFloatId,
        personalName: userProfile.personalName,
        familyName: userProfile.familyName,
        nationalId: userProfile.nationalId,
        userStatus: userProfile.userStatus,
        kycStatus: userProfile.kycStatus
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
    rowForTable.updatedTimeEpochMillis = creationTime.valueOf()

    const resultOfInsertion = await dynamoCommon.insertNewRow(config.get('tables.dynamo.profileTable'), ['systemWideUserId'], rowForTable);
    logger('Result of inserting profile, from DynamoDB: ', resultOfInsertion);
    if (!resultOfInsertion || resultOfInsertion.result !== 'SUCCESS') {
        return { result: 'ERROR', message: 'FAILED_AT_LAST_HURDLE' }
    };
    
    return {
        result: 'SUCCESS',
        systemWideUserId: systemWideUserId,
        creationTimeEpochMillis: creationTime.valueOf()
    };
};

module.exports.fetchUserProfile = async (systemWideUserId) => {
    logger('Seeking user with system ID: ', systemWideUserId);
    const itemFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamo.profileTable'), { systemWideUserId });
    logger('Back from Dynamo: ', itemFromDynamo);
    return Object.keys(itemFromDynamo).length === 0 ? null : itemFromDynamo;
};

module.exports.fetchUserByNationalId = async (clientId, nationalId) => {
    logger('Seeking a user with national ID: ', nationalId);
    const itemFromDynamo = await dynamoCommon.fetchSingleRow(config.get('tables.dynamo.nationalIdTable'), { clientId, nationalId });
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