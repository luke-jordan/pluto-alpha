'use strict';

const logger = require('debug')('pluto:auth:password-update-λ-main')
const passwordAlgorithm = require('./password-algo')
const rdsUtil = require('./utils/rds-util');


/**
 * This λ function stands between client facing firmware and a persistence database. This function uses the basic-lambda-authorizer
 * to verify whether the caller has permissions to access this function. In future thos function will also
 * facilitate user notification via email (through another lambda function) on successful password change.
 * @param {string} event.oldPassword The users current password (the one to be replaced. The λ verifies this password (statelessly) and if valid replaces it with an encrypted
 * @param {string} event.newPassword The users new password. If oldPassword is correct, this password in encrypted and persisted.
 * @param {object} event.origin This provides information about the origin of the request. In most cases the objects will indicate administrator or direct user origin.
 * @param {object} context.rolesAndPermissions An obejct containing details of the origin's roles and permissions. 
 */


module.exports.updatePassword = async (event, context) => {
	try {
		logger('recieved context', context);
		
		const oldPassword = event.oldPassword;
		const newPassword = event.newPassword;
		const systemWideUserId = event.systemWideUserId;

		const oldPasswordValidation = await passwordAlgorithm.verifyPassword(systemWideUserId, oldPassword);
		logger('is old password valid:', oldPasswordValidation.verified);

		if (oldPasswordValidation.verified) {
			const saltAndVerifier = await passwordAlgorithm.generateSaltAndVerifier(systemWideUserId, newPassword);
			logger('generated salt and verifier:', saltAndVerifier);
			const salt = saltAndVerifier.salt;
			const verifier = saltAndVerifier.verifier;
			const databaseResponse = await rdsUtil.updateUserSaltAndVerifier(systemWideUserId, salt, verifier);
			logger('password update databaseResponse:', databaseResponse);
			if (databaseResponse.statusCode == 0) {
				return {
					statusCode: 200,
					body: JSON.stringify({
						message: databaseResponse.message
					}, null, 2),
				};
			} 
			else throw new Error(databaseResponse.message);
		} else throw new Error(oldPasswordValidation.reason);
	} catch (err) {
		logger("FATAL_ERROR:", err);
		return {
			statusCode: 500,
			body: JSON.stringify({
				message: err.message
			}, null, 2),
		};
	};
};
