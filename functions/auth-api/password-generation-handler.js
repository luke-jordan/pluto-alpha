'use strict';

const logger = require('debug')('pluto:alpha:password-generator-lambda-main');
const passwordAlgorithm = require('../user-insertion-lambda/password-algo');
const request = require('request-promise');
const passwordGenerator = require('niceware');
const rdsUtil = require('../utils/rds-util');


module.exports.generateEphemeralPassword = async (event) => {
    try {
		logger('recieved event:', event);

		const generatedPassword = exports.generatePassword();
		const saltAndVerifier = passwordAlgorithm.generateSaltAndVerifier(systemWideUserId, generatedPassword);
		logger('generated salt and verifier:', saltAndVerifier);
		const databaseResponse = exports.persistSaltAndVerifier(event.targetUserId, saltAndVerifier.salt, saltAndVerifier.verifier);
		logger('password update databaseResponse:', databaseResponse);
		const databaseResponse = await exports.persistSaltAndVerifier(event.targetUserId, saltAndVerifier.salt, saltAndVerifier.verifier);
		if (!databaseResponse || databaseResponse.statusCode > 0) throw new err('error while persisting new password keys databaseResponse');

		const passwordUpdateMessage = 'TIMESTAMP USERID reset their password.';
		const notificationCheckList = notifyAdministrators(passwordUpdateMessage);
		logger('details of all admin notification operations:', notificationCheckList);

		const response = {
			password: generatedPassword,
			notificationResult: notificationCheckList
		};

		return {
			statusCode: 200,
			body: JSON.stringify({
				message: response,
				input: event,
			}, null, 2),
		};
	} catch (err) {
		logger('FATAL_ERROR', err);
		return {
			statusCode: 500,
			body: JSON.stringify({
				message: err.message,
				input: event,
			}, null, 2),
		};
	}
};


// the seperation of this function from the handler makes it easier to test
module.exports.persistSaltAndVerifier = async (targetUserId, salt, verifier) => {
	const databaseResponse = await rdsUtil.updateUserSaltAndVerifier(targetUserId, salt, verifier);
    return databaseResponse; // or transform prior to this line
};


module.exports.generatePassword = () => {
	const passwordArray = passwordGenerator.generatePassphrase(6);
	const password = passwordArray.join('_'); // policy conforming?
	return password;
};


module.exports.fetchAdmins = () => {
	// get list of adminstrator emails/contact details from s3
	return [];
};


module.exports.notifyAdministrators = async (passwordUpdateResult) => {
	const admins = exports.fetchAdmins();
	const results = [];
	for ( i = 0; i < admins.length; i++ ) {
		const response = await notifyAdmin(admin[i], passwordUpdateMessage);
		logger('notification of admin ${admin[i]} returned:', response);
		results.push(response);
	};
};


module.exports.notifyAdmin = async (adminContactObject, updateMessage) => {
	// should recurse through admin list and notify each of user password change?
};
