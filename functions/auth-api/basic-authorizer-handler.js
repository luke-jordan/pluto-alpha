'use strict';

const logger = require('debug')('pluto:authoriser-lambda:main');
const request = require('request-promise');
const config = require('config');

module.exports.basicLambdaAuthorizer = async (event, context, callback) => {
	try {
		logger('Recieved event:', event);
		const verifyOptions = event.queryStringParameters.verifyOptions;
		// const verifyOptions = {
		// 	issuer: 'Pluto Saving',
		// 	subject: 'a-system-wide-user-id',
		// 	audience: 'https://plutosaving.com'
		// };

		const rawToken = event.authorizationToken;
		const token = rawToken.substring('Bearer '.length);
		logger('Spliced auth header:', token)

		const tokenStatus = await exports.validateToken(token, verifyOptions);
		logger('auth lambda recieved:', tokenStatus, 'from jwt validation');
		
		if (tokenStatus.verified) {
			const userRoleAndPermissions = exports.getRolesAndPermissions(tokenStatus.decoded);
			logger('user role and permissions:', userRoleAndPermissions);
			const generatedPolicy = exports.generateAllow(userRoleAndPermissions.systemWideUserId, event.methodArn, userRoleAndPermissions);
			logger('generated policy:', generatedPolicy);
			callback(null, JSON.stringify(generatedPolicy));
		} else {
			callback('Unauthorized');
		};
	} catch (err) {
		logger("FATAL_ERROR:", err);
		callback('Unauthorized');
	};
};


module.exports.validateToken = async (token, verifyOptions) => {
	logger('running in validateToken');
	const verifyParams = {
		url: config.get('jwtLambdaUrl'),
		method: 'GET',
		qs: {
			token: token, 
			verifyOptions: verifyOptions
		},
		json: true
	};

	logger('about to hit up server with params', verifyParams);

	return await request(verifyParams)
	    .then((response) => {
			logger('Got this response back from token validation:', response);
			return response
		})
		.catch((err) => {
			logger('Error validating token:', err);
			return {verifed: false, reason: err.message};
		});
};


module.exports.generatePolicy = (principalId, effect, resource, userRoleAndPermissions) => {
	let authResponse = {
		principalId: principalId,
	};
    if (effect && resource) {
		authResponse.policyDocument = {
			Version: '2012-10-17',
			Statement: [{
				Action: 'execute-api:Invoke',
				Effect: effect,
				resource: resource
			}],
		};
		authResponse.context = userRoleAndPermissions;
	};
    return authResponse;
};


module.exports.generateAllow = (principalId, resource, userRoleAndPermissions) => {
    return exports.generatePolicy(principalId, 'Allow', resource, userRoleAndPermissions);
};


module.exports.getRolesAndPermissions = (decodedToken) => {
	return {
		systemWideUserId: decodedToken.systemWideUserId,
		role: decodedToken.role,
		permissions: decodedToken.permissions
	};
};