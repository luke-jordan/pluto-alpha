'use strict';

const srp = require('secure-remote-password/client');
const logger = require('debug')('pluto:auth:password-algo-main')
const verifierHelper = require('./user-verification-helper');


module.exports.generateSaltAndVerifier = (systemWideUserId, password) => {
    if (systemWideUserId && password) {
        const salt = srp.generateSalt();
        const privateKey = srp.derivePrivateKey(salt, systemWideUserId, password);
        const verifier = srp.deriveVerifier(privateKey);

        return { systemWideUserId, salt, verifier };
    }
    return {error: 'Invalid input'};
};


module.exports.verifyPassword = async (systemWideUserId, password) => {
    try {
        logger('recieved params:', systemWideUserId, password)
        const clientEphemeral = srp.generateEphemeral();
        logger('generated client ephemeral:', clientEphemeral);
        let response = await verifierHelper.getSaltAndServerPublicEphemeral(systemWideUserId, clientEphemeral.public);
        response = JSON.parse(response);
        logger('first server response:', response)
        if (!response) return {systemWideUserId: systemWideUserId, verified: false, reason: 'No response from server'};
        const salt = response.salt;
        const serverPublicEphemeral = response.serverPublicEphemeral;
        logger(salt, serverPublicEphemeral);
        const privateKey = srp.derivePrivateKey(salt, systemWideUserId, password);
        logger('derived private key:', privateKey);
        const clientSession = srp.deriveSession(clientEphemeral.secret, serverPublicEphemeral, salt, systemWideUserId, privateKey);
        logger('args passed to clientSession generator:', clientEphemeral.secret, '|', serverPublicEphemeral, '|', salt, '|', systemWideUserId, '|',  privateKey);
        logger('generated client session:', clientSession);
        const serverResponseJson = await verifierHelper.getServerSessionProof(systemWideUserId, clientSession.proof, clientEphemeral.public);
        logger('second server response:', serverResponseJson);
        const serverResponse = JSON.parse(serverResponseJson);
        logger('server session proof object keys:', Object.keys(serverResponse));
        try {
            if (!serverResponse) throw new Error('Server session proof not recieved')
            srp.verifySession(clientEphemeral.public, clientSession, serverResponse.serverSessionProof);
            return {systemWideUserId: systemWideUserId, verified: true};
        }
        catch (err) {
            return {systemWideUserId: systemWideUserId, verified: false, reason: err.message};
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
    };
};
