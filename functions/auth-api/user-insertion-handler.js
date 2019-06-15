'use strict';

const config = require('config');
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
        logger('Running in handler');
        logger('Recieved context:', context);
        const input = event['queryStringParameters'] || event;

        logger('Recieved: systemWideUserId:', input.systemWideUserId, ', Password length:', input.password.length);
        const saltAndVerifier = passwordAlgorithm.generateSaltAndVerifier(input.systemWideUserId, input.password);

        const newUser = rdsUtil.createNewUser(input.systemWideUserId, saltAndVerifier.salt, saltAndVerifier.verifier);
        const userRolesAndPermissions = await authUtil.assignUserRolesAndPermissions(input.systemWideUserId, input.requestedRole); // λfy
        const databaseInsertionResponse = await rdsUtil.insertNewUser(newUser);
        // if database insertion successful get jwt, else return databaseInsertionResponse message
        const signOptions = authUtil.getSignOptions(input.systemWideUserId);

        logger(userRolesAndPermissions);
        logger(signOptions);
        const jsonWebToken = await jwt.generateJsonWebToken(userRolesAndPermissions, signOptions)
        logger('JWT:', jsonWebToken);

        const response = {
            jwt: jsonWebToken, // λfy 
            message: databaseInsertionResponse.databaseResponse
        };

        return {
            statusCode: 200,
            body: JSON.stringify(response)
        };

    } catch (err) {
        logger("FATAL_ERROR:", err);
        const response = {message: err.message};
        
        return {
            statusCode: 500,
            body: JSON.stringify(response)
        };
    }
};
