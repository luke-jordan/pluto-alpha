'use strict';

const logger = require('debug')('pluto:auth:jwt-λ-main');
const jwt = require('./utils/jwt');


module.exports.verifyJsonWebToken = async (event) => {
    try {
		logger("recieved event:", event);
		const verifyOptions = event.verifyOptions;
		const token = event.token;
		const validToken = await jwt.verifyJsonWebToken(token, verifyOptions); 
		logger("result of token validation:", validToken);
		if (validToken) {
            const response = {
				verified: true,
				decoded: validToken // assuming it got decoded during validation
			};
			return {
				statusCode: 200,
				body: JSON.stringify({
				message: response,
				input: event,
				}, null, 2),
			};
		} else throw new Error('Invalid token');
	} catch (err) {
		logger('FATAL_ERROR', err);
		const response = {
			validated: false,
			reason: err.message
		};
		return {
			statusCode: 500,
			body: JSON.stringify({
			message: response,
			input: event,
			}, null, 2),
		};
	};
};


module.exports.signJsonWebToken = async (event) => {
	logger("signJsonWebToken function recieved event:", event)
	try {
		const signOptions = event.signOptions;
		const payload = event.payload;
		const token = await jwt.generateJsonWebToken(payload, signOptions);
		logger('result of token generation:', token);
        if (token) {
			const response = { token: token };

			return {
				statusCode: 200,
				body: JSON.stringify({
				message: response,
				input: event,
				}, null, 2),
			};
		} else throw new Error('call to jwt module did not return token');
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