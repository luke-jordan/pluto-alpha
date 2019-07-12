'use strict';

const logger = require('debug')('jupiter:profile:handler');

// const validator = require('validator');

const dynamo = require('./persistence/dynamodb');

// https://stackoverflow.com/questions/11746894/what-is-the-proper-rest-response-code-for-a-valid-request-but-an-empty-data
const USER_CONFLICT_CODE = 409;
const UNKNOWN_INTERNAL_ERROR_CODE = 500;

const USER_NOT_FOUND_CODE = 404;
const NOT_FOUND_RESPONSE = { statusCode: USER_NOT_FOUND_CODE };

const FORBIDDEN_CODE = 403;
const NO_PERMISSION_RESPONSE = { statusCode: FORBIDDEN_CODE };

const INVALID_REQUEST_CODE = 400;

const SYSTEM_ADMIN_ROLE = 'SYSTEM_ADMIN';
const SYSTEM_WORKER_ROLE = 'SYSTEM_WORKER';

const isSystemAdminOrWorker = (context) => context.userRole === SYSTEM_ADMIN_ROLE || context.userRole === SYSTEM_WORKER_ROLE;

const assembleErrorBody = (message, type, field) => JSON.stringify({
    message: message,
    errorType: type,
    errorField: field
});

const handleInsertionError = (dynamoErrorMessage) => {
    switch (dynamoErrorMessage) {
        case 'NATIONAL_ID_TAKEN':
            return { statusCode: USER_CONFLICT_CODE, body: assembleErrorBody('A user with that national ID already exists', 'NATIONAL_ID_TAKEN', 'NATIONAL_ID') };
        case 'ERROR_INSERTING_NATIONAL_ID':
            return { statusCode: USER_CONFLICT_CODE, body: assembleErrorBody('Conflict (possible race condition) on national ID', 'NATIONAL_ID_CONFLICT', 'NATIONAL_ID') };
        case 'EMAIL_TAKEN':
            return { statusCode: USER_CONFLICT_CODE, body: assembleErrorBody('A user with that email address already exists', 'EMAIL_TAKEN', 'EMAIL_ADDRESS')};
        default:
            return { statusCode: UNKNOWN_INTERNAL_ERROR_CODE, body: assembleErrorBody('Unknown server error, examine logs', 'UNKNOWN', 'UNKNOWN') };
    }

};

/**
 * 
 * @param {string} clientId The id of the client that this user is being signed up for/with/through
 * @param {string} defaultFloatId The default float that this user's savings will be added to
 * @param {string} userRole The role for this user (if not provided, defaults to ordinary user)
 * @param {string} personalName The user's personal (usually first) name
 * @param {string} middleName The user's middle name, optional (leaving space in case)
 * @param {string} familyName The user's family (usually last) name 
 * @param {string} primaryPhone The user's primary mobile phone. Must be in E164 / 'msisdn' format. Unique. Optional if email provided.  
 * @param {string} primaryEmail The user's primary email. Unique. Optional if phone number provided.
 * @param {string} nationalId A uniquely identifying number (legally) in the user's country (often a national ID number, or also social security number, or similar) 
 * @param {string} userStatus The user's system status (see README). If not provided, defaults to CREATED. 
 * @param {string} kycStatus Where the user sits in the KYC process (again see README). If not provided, defaults to NO_INFO.
 * @param {boolean} passwordSet Whether user has already set a password [but actually will always be false ...] 
 * @param {array} tags Optional. A set of tags to associate with the user 
 */
module.exports.insertNewUser = async (event) => {
    // todo : validate client & float IDs
    try {
        const resultOfInsertion = await dynamo.insertUserProfile(event);
        logger('Well, did that work: ', resultOfInsertion);
        if (resultOfInsertion.result === 'SUCCESS') {
            const resultBody = {
                systemWideUserId: resultOfInsertion.systemWideUserId,
                persistedTimeMillis: resultOfInsertion.creationTimeEpochMillis
            };
            return { statusCode: 200, body: JSON.stringify(resultBody) };
        }
        // otherwise something went wrong
        return handleInsertionError(resultOfInsertion.message);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: 500, body: JSON.stringify(err) };
    }
};

/**
 * Does what it says on the tin. Can only be called by the user themselves or by system admin.
 * @param {string} systemWideId The primary user ID
 */
module.exports.fetchUserBySystemId = async (event, context) => {
    // logger('Fetch user called, with context: ', context);
    if (!context) {
        return NO_PERMISSION_RESPONSE;
    }

    const params = event.body || event;

    const needAdminRole = !context.systemWideId || (params.systemWideId && context.systemWideId !== params.systemWideId);
    if (needAdminRole && !isSystemAdminOrWorker(context)) {
        return NO_PERMISSION_RESPONSE;
    }
    
    const systemWideId = params.systemWideId || context.systemWideId;
    const fetchedProfile = await dynamo.fetchUserProfile(systemWideId);
    if (fetchedProfile) {
        return {
            statusCode: 200,
            body: JSON.stringify(fetchedProfile)
        };
    } 

    return NOT_FOUND_RESPONSE;
};

/**
 * Looks up a user profile by one of their unique personal details. At minimum one parameter is required (and client id is necessary 
 * with national id), but if more than one is provided, lookup will happen in order: national id - phone number - email address, until 
 * a user profile is found. Returns a projection containing only the system wide ID.
 * @param {string} clientId The ID of the client responsible for the user (only necessary if national ID is used for lookup)
 * @param {string} nationalId The national ID number of the user (requires client id to be provided)
 * @param {string} phoneNumber The user's phone number, in msisdn format (i.e., E164)
 * @param {string} emailAddress The user's primary email address
 */
module.exports.fetchUserByPersonalDetail = async (event) => {
    const params = event.body || event;
    const isNationalIdPresent = params.clientId && params.nationalId;
    let foundUserId = null;
    if (isNationalIdPresent) {
        foundUserId = await dynamo.fetchUserByNationalId(params.clientId, params.nationalId);
    }

    if (!foundUserId && params.phoneNumber) {
        foundUserId = await dynamo.fetchUserByPhone(params.phoneNumber);
    }

    if (!foundUserId && params.emailAddress) {
        foundUserId = await dynamo.fetchUserByEmail(params.emailAddress);
    }

    logger('Completed queries for user, result: ', foundUserId);
    if (foundUserId) {
        return {
            statusCode: 200,
            body: JSON.stringify({ systemWideUserId: foundUserId })
        };
    } 
    
    return NOT_FOUND_RESPONSE;
};

/**
 * Updates the user's system status (see the README in this folder for the potential status types). Pass the updates in the form
 * newUserStatus: { changeTo: 'ACCOUNT_OPENED', reasonToLog: 'Completed onboarding' }
 * @param {string} systemWideUserId The user's system wide ID (note: context drops 'user' because ID pool can have non-user entities)
 * @param {string} updatedUserStatus The status to which to update the user
 * @param {string} updatedKycStatus The status to which to update the user
 * @param {string} updatedSecurityStatus Whether the user has a password set or not (and in time, if MFA, etc., is turned on)  
 */
module.exports.updateUserStatus = async (event, context) => {
    // todo : add in the logging (need a table)
    // todo : KYC update also can't be called by the user themselves
    const params = event.body || event;
    const needAdminRole = !context.systemWideId || context.systemWideId !== params.systemWideUserId || Boolean(params.updatedKycStatus);
    logger('Updating status, requires admin role? : ', needAdminRole);

    if (needAdminRole && !isSystemAdminOrWorker(context)) {
        logger('Need admin role since context Id: ', context.systemWideId, ' and params user id: ', params.systemWideUserId);
        return NO_PERMISSION_RESPONSE;
    }
    
    const updateInstruction = { };
    if (params.updatedUserStatus) {
        updateInstruction.userStatus = params.updatedUserStatus.changeTo;
    }

    if (params.updatedKycStatus) {
        updateInstruction.kycStatus = params.updatedKycStatus.changeTo;
    }

    if (params.updatedSecurityStatus) {
        updateInstruction.securityStatus = params.updatedSecurityStatus.changeTo;
    }
    
    if (Object.keys(updateInstruction) === 0) {
        return { statusCode: INVALID_REQUEST_CODE, body: 'Must update at least one field to be valid call' };
    }

    try {
        const userIdChanging = params.systemWideUserId || context.systemWideUserId;
        const dynamoUpdate = await dynamo.updateUserStatus(userIdChanging, updateInstruction);
        logger('Result from Dynamo call: ', dynamoUpdate);
        return {
            statusCode: 200,
            body: JSON.stringify({ updatedTimeMillis: dynamoUpdate.updatedTimeEpochMillis })
        };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: UNKNOWN_INTERNAL_ERROR_CODE, body: err.message };
    }
};

/**
 * Updates record of when was the last time the user performed a full login
 * @param {string} systemWideId The user's ID
 * @param {number} lastFullLoginTimeEpochMills The new timestamp
 */
module.exports.updateUserLastLogin = async (event, context) => {
    if (!context || !context.systemWideId) {
        return NO_PERMISSION_RESPONSE;
    }

    try {
        const resultOfUpdate = await dynamo.updateUserLastLogin(context.systemWideId, event.loggedInTimeEpochMillis);
        return {
            statusCode: 200,
            body: JSON.stringify({ lastLoginTimeMillis: resultOfUpdate.lastLoginTimeMillis })
        };
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: UNKNOWN_INTERNAL_ERROR_CODE, body: err.message };
    }
};

/**
 * Generic update method for the rest of a user profile properties. Updates one or more of:
 * @param {string} systemWideId The user's system id
 * @param {array} tags A set of tags to associate with the user's profile
 * @param {string} primaryPhone A new phone number for the user
 * @param {string} primaryEmail A new primary email for the user
 * @param {array} backupPhones Any secondary phones the user adds
 * @param {array} backupEmails Any backup emails for the user 
 */
module.exports.updateUserDetails = async (event, context) => {
    if (!context || !context.systemWideId) {
        return NO_PERMISSION_RESPONSE;
    }

    // todo : validation
    const params = event.body || event;
    const updateInstruction = { };
    
    if (params.primaryPhone) {
        updateInstruction.primaryPhone = params.primaryPhone;
    }

    if (params.primaryEmail) {
        updateInstruction.primaryEmail = params.primaryEmail;
    }

    // todo: add others once time to revert and work out updating lists
    try {
        logger('Sending instruction: ', updateInstruction);
        const resultOfUpdate = await dynamo.updateUserProfile(context.systemWideId, updateInstruction);
        logger('Result of updte: ', resultOfUpdate);
        if (resultOfUpdate.result === 'SUCCESS') {
            return {
                statusCode: 200,
                body: JSON.stringify({ updatedTimeMillis: resultOfUpdate.updatedTimeMillis })
            };
        }

        return handleInsertionError(resultOfUpdate.message);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: UNKNOWN_INTERNAL_ERROR_CODE, body: err.message };
    }
};
