'use strict';

const logger = require('debug')('pluto:auth-password-update-λ:main')
const passwordAlgorithm = require('../user-insertion-lambda/password-algo')
const rdsUtil = require('../utils/rds-util');


/**
 * This λ function stands between client facing firmware and a persistence database. This function uses the basic-lambda-authorizer
 * to verify whether the caller has 
 * @param event.oldPassword S; The users current password (the one to be replaced. The λ verifies this password (statelessly) and if valid replaces it with an encrypted
 * @param event.newPassword S; The users new password. If oldPassword is correct, this password in encrypted and persisted.
 * @param event.origin {}; This provides information about the origin of the request. In most cases the objects will indicate administrator or direct user origin.
 * @param context.rolesAndPermissions {}; An obejct containing details of the origin's roles and permissions. 
 */


module.exports.updatePassword = async (event, context) => {
	try {
		logger('recieved event:', event);
		logger('recieved context', context);
		
		const oldPassword = event.oldPassword;
		const newPassword = event.newPassword;
		const origin = event.origin;
		logger('event origin:', origin);
		const systemWideUserId = event.systemWideUserId; // or load from context?

		const oldPasswordValid = passwordAlgorithm.verifyPassword(systemWideUserId, oldPassword);

		if (oldPasswordValid) {
			const saltAndVerifier = passwordAlgorithm.generateSaltAndVerifier(systemWideUserId, newPassword);
			const salt = saltAndVerifier.salt;
			const verifier = saltAndVerifier.verifier;
			const databaseResponse = rdsUtil.updateUser(systemWideUserId, salt, verifier); // TODO: implement rdsUtil.updateUser;
			if (databaseResponse.statusCode == 0) {
				return {
					statusCode: 200,
					body: JSON.stringify({
					message: databaseResponse.message,
					input: event,
					}, null, 2),
				};
			}
			else throw new Error('An error occured during database update attempt.');
		} else throw new Error('Invalid old password');
	} catch (err) {
		return {
			statusCode: 500,
			body: JSON.stringify({
			message: err.message,
			input: event,
			}, null, 2),
		};
	};
};
