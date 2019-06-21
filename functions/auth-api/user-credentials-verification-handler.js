'use strict';

const logger = require('debug')('pluto:auth:user-credentials-verification-λ-main');
const passwordAlgorithm = require('./password-algo');

/**
 * A quick note on passwordAlgorithm.verifyPassword()
 * This function returns an object 
 */


module.exports.verifyUserCredentials = async (event) => {
	try {
		logger('recieved event:', event);
		const password = event.password;
		const systemWideUserId = event.systemWideUserId;

		const passwordValidationResponse = await passwordAlgorithm.verifyPassword(systemWideUserId, password);
		logger('response from password validation:', passwordValidationResponse);

		return {
			statusCode: 200,
			body: JSON.stringify({
				message: passwordValidationResponse
			}, null, 2),
		};
	} catch (err) {
		logger('FATAL_ERROR', err);
		return {
			statusCode: 500,
			body: JSON.stringify({
			  message: err.message
			}, null, 2),
		};
	};
};