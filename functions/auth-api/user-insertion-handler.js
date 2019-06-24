'use strict';

const logger = require('debug')('pluto:auth:user-insertion-λ-main');

const passwordAlgorithm = require('./password-algo');
const rdsUtil = require('./utils/rds-util');
const authUtil = require('./utils/auth-util');
const jwt = require('./utils/jwt');

/** This function generates persistable user credentials, persists them to RDS, sends the 
 *  user to a JWT auth lamda where the user is assigned roles and permissions and the
 *  the corresponing JSON Web Token. Finally, the result of these operations along with the JWT
 *  is returned to the caller. 
 */
module.exports.insertUserCredentials = async (event, context) => {
    try {
        logger('Recieved context:', context);
        const input = event['queryStringParameters'] || event;
        if (!input.systemWideUserId || !input.password) throw new Error('invalid event passed to handler');
        logger('recieved: event user id and password length', input.systemWideUserId, ', Password length:', input.password.length);
        const saltAndVerifier = passwordAlgorithm.generateSaltAndVerifier(input.systemWideUserId, input.password);
        const newUserCredentials = rdsUtil.createUserCredentials(input.systemWideUserId, saltAndVerifier.salt, saltAndVerifier.verifier);
        const userRolesAndPermissions = await authUtil.assignUserRolesAndPermissions(input.systemWideUserId, input.requestedRole); // λfy
        const databaseInsertionResponse = await rdsUtil.insertUserCredentials(newUserCredentials);
        // if database insertion successful get jwt, else return databaseInsertionResponse message
        const signOptions = authUtil.getSignOptions(input.systemWideUserId);
        logger(signOptions, userRolesAndPermissions);
        const jsonWebToken = await jwt.generateJsonWebToken(userRolesAndPermissions, signOptions)
        logger('got this back from jwt generation:', jsonWebToken);

        return {
            statusCode: 200,
            body: JSON.stringify({
                jwt: jsonWebToken,
                message: databaseInsertionResponse.databaseResponse
            })
        };
    } catch (err) {
        logger("FATAL_ERROR:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: err.message
            })
        };
    };
};
