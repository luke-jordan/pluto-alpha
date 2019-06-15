'use strict';

const logger = require('debug')('pluto:auth:user-credentials-verification-λ-main');
const passwordAlgorithm = require('./password-algo');


module.exports.verifyUserCredentials = async (event) => {
	try {
		logger('recieved event:', event);
		const password = event.password;
		const systemWideUserId = event.systemWideUserId;

		const validPassword = await passwordAlgorithm.verifyPassword(systemWideUserId, password);

		if (validPassword) {
			return {
				statusCode: 200,
				body: JSON.stringify({
				  message: validPassword,
				  input: event,
				}, null, 2),
			  };
		} else throw new Error('Invalid password');
	} catch (err) {
		logger('FATAL_ERROR', err);
		return {
			statusCode: 500,
			body: JSON.stringify({
			  message: err.message,
			  input: event,
			}, null, 2),
		};
	};
};