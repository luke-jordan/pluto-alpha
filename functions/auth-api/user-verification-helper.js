'use strict';

const logger = require('debug')('pluto:auth:user-verification-helper-main');
const srp = require('secure-remote-password/server');
const rdsUtil = require('./utils/rds-util');

// λfy?
module.exports.getSaltAndServerPublicEphemeral = async (systemWideUserId, clientPublicEphemeral) => {
    try {
        const userAccessCredentials = await rdsUtil.getUserCredentials(systemWideUserId);
        logger('got this back from user credentials extraction:', userAccessCredentials);
        if (userAccessCredentials.error) throw new Error(userAccessCredentials.error)
        logger('respose object has keys:', Object.keys(userAccessCredentials[0]));
        const salt = userAccessCredentials[0].salt;
        const verifier = userAccessCredentials[0].verifier; 
        const serverEphemeral = srp.generateEphemeral(verifier);
        logger('generated server ephemeral', serverEphemeral);
        const databaseResponse = await rdsUtil.updateServerEphemeralSecret(systemWideUserId, serverEphemeral.secret)
        logger('response from db:', databaseResponse);
        return JSON.stringify({
            salt: salt,
            serverPublicEphemeral: serverEphemeral.public 
        });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return JSON.stringify({
            salt: null,
            serverPublicEphemeral: null,
            reason: err.message 
        });
    };
};


module.exports.getServerSessionProof = async (systemWideUserId, clientSessionProof, clientPublicEphemeral) => {
    try {
        const userAccessCredentials = await rdsUtil.getUserCredentials(systemWideUserId);
        logger('getServerSessionProof got this back from user credentials extraction:', userAccessCredentials);
        if (userAccessCredentials.error) throw new Error(userAccessCredentials.error)
        const serverEphemeralSecret = userAccessCredentials[0].server_ephemeral_secret;
        const salt = userAccessCredentials[0].salt;
        const verifier = userAccessCredentials[0].verifier;
        logger(serverEphemeralSecret, salt, verifier);
        const serverSession = srp.deriveSession(
            serverEphemeralSecret,
            clientPublicEphemeral,
            salt,
            systemWideUserId,
            verifier,
            clientSessionProof
        );
        logger('generated server session:', serverSession);
        return JSON.stringify({
            serverSessionProof: serverSession.proof    
        });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return JSON.stringify({
            serverSessionProof: null,
            reason: err.message
        })
    };
};