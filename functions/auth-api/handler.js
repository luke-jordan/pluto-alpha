'use strict';

const config = require('config');
const logger = require('debug');

const passwordAlgorithm = require('./pwordalgo');
const rdsUtil = require('./rdsUtil');
const authUtil = require('./authUtil');
const jwt = require('./jwt');

// This function generates persistable user credentials, persists them to RDS, sends the 
// user to a JWT auth lamda where the user is assigned roles and permissions and the
// the corresponing JSON Web Token. Finally, the result of these operations along with the JWT
// is returned to the caller.
module.exports.insertNewUser = async (event, context) => {
	logger('Running in handler')
    const input = event['queryStringParameters'] || event;

    console.log('Recieved ', input.systemWideUserId, input.password.length);
    const encryption = passwordAlgorithm.generateSaltAndVerifier(input.systemWideUserId, input.password);
	
	const newUser = rdsUtil.createNewUser(input.systemWideUserId, encryption.salt, encryption.verifier);
	const userRolesAndPermissions = authUtil.assignUserRolesAndPermissions(input.systemWideUserId, input.userRole); // λfy
	const signOptions = authUtil.getSignOptions(input.systemWideUserId);
	const databaseInsertionResponse = rdsUtil.insertNewUser(newUser);

	const response = {
		jwt: jwt.generateJSONWebToken(userRolesAndPermissions, signOptions), // λfy 
		message: databaseInsertionResponse.databaseResponse
	}

	return {
		statusCode: 200,
		body: JSON.stringify(response),
	};
};

module.exports.loginUser = async (event, context) => {
	// const input = event['queryStringParameters'] || event;

	// const loginResult = passwordAlgorithm.loginExistingUser(input.systemWideUserId, input.password);
	// if (loginResult.verified) {
	// 	   get user roles and permissions
	// 	   generate jwt
	// }
	// transform final result as prescribed by docs

};

module.exports.changePassword = async (event, context) => {

};

module.exports.getOTP = async (event, context) => {
	
}