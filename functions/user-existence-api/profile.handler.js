'use strict';

const logger = require('debug')('jupiter:profile:handler');

const uuid = require('uuid/v4');
const validator = require('validator');

const dynamo = require('./persistence/dynamo');

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
module.exports.insertNewUser = async (event, context) => {
    
}

/**
 * Does what it says on the tin. Can only be called by the user themselves or by system admin.
 * @param {string} systemWideId The primary user ID
 */
module.exports.fetchUserBySystemId = async (event, context) => {
    const params = event.body || event;
    const systemWideId = params.systemWideId;
}

/**
 * Looks up a user profile by one of their unique personal details. At minimum one parameter is required (and client id is necessary 
 * with national id), but if more than one is provided, lookup will happen in order: national id - phone number - email address, until 
 * a user profile is found. Returns a projection containing only the system wide ID, and the contact details provided.
 * @param {string} clientId The ID of the client responsible for the user (only necessary if national ID is used for lookup)
 * @param {string} nationalId The national ID number of the user (requires client id to be provided)
 * @param {string} phoneNumber The user's phone number, in msisdn format (i.e., E164)
 * @param {string} emailAddress The user's primary email address
 */
module.exports.fetchUserByPersonalDetail = async (event, context) => {
    const params = event.body || event;

}

/**
 * Updates the user's system status (see the README in this folder for the potential status types)
 * @param {string} systemWideId The user's system wide ID
 * @param {string} newUserStatus The status to which to update the user
 * @param {string} reasonToLog Why the status is being updated
 */
module.exports.updateUserStatus = async (event) => {
    
}

/**
 * Updates the user's KYC (know your customer - regulatory) status. See README for potential states.
 * @param {string} systemWideId The user's ID
 * @param {string} newKycStatus The status to which to update the user
 * @param {string} reasonToLog A log to record for the cause of the change
 */
module.exports.updateUserKycStatus = async (event, context) => {

}

/**
 * Updates whether or not the user has secured their account by setting a password
 * @param {string} systemWideId The user's ID
 * @param {string} userSecurityStatus Whether the user has a password set or not (and in time, if MFA, etc., is turned on) 
 */
module.exports.updateWhetherUserIsSecured = async (event, context) => {

}

/**
 * Updates record of when was the last time the user performed a full login
 * @param {string} systemWideId The user's ID
 * @param {number} lastFullLoginTimeEpochMills The new timestamp
 */
module.exports.updateUserLastLogin = async (event, context) => {

}

/**
 * Generic update method for the rest of a user profile properties. Updates one or more of:
 * @param {string} systemWideId The user's system id
 * @param {array} tags A set of tags to associate with the user's profile
 * @param {string} primaryPhone A new phone number for the user
 * @param {string} primaryEmail A new primary email for the user
 * @param {array} backupPhones Any secondary phones the user adds
 * @param {array} backupEmails Any backup emails for the user 
 */
module.exports.updateUserDetails = (event, context) => {

}