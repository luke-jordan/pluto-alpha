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
        let saltAndServerPublicEphemeralJson = await verifierHelper.getSaltAndServerPublicEphemeral(systemWideUserId, clientEphemeral.public);
        const saltAndServerPublicEphemeral = JSON.parse(saltAndServerPublicEphemeralJson);
        logger('got the following values for salt and server public ephemeral:', saltAndServerPublicEphemeral)
        if (!saltAndServerPublicEphemeral) return {systemWideUserId: systemWideUserId, verified: false, reason: 'saltAndServerPublicEphemeral not recieved'};
        const salt = saltAndServerPublicEphemeral.salt;
        const serverPublicEphemeral = saltAndServerPublicEphemeral.serverPublicEphemeral;
        logger(salt, serverPublicEphemeral);
        const privateKey = srp.derivePrivateKey(salt, systemWideUserId, password);
        logger('derived private key:', privateKey);
        const clientSession = srp.deriveSession(clientEphemeral.secret, serverPublicEphemeral, salt, systemWideUserId, privateKey);
        logger('args passed to clientSession generator:', clientEphemeral.secret, '|', serverPublicEphemeral, '|', salt, '|', systemWideUserId, '|',  privateKey);
        logger('generated client session:', clientSession);
        try {
            const serverSessionProofJson = await verifierHelper.getServerSessionProof(systemWideUserId, clientSession.proof, clientEphemeral.public);
            logger('second server response:', serverSessionProofJson);
            const serverSessionProof = JSON.parse(serverSessionProofJson);
            if (serverSessionProof.serverSessionProof == null) throw new Error(serverSessionProof.reason);
            logger('server session proof object keys:', Object.keys(serverSessionProof));
            // srp.verifySession throws error on invalid password
            srp.verifySession(clientEphemeral.public, clientSession, serverSessionProof.serverSessionProof);
            return {systemWideUserId: systemWideUserId, verified: true};
        } catch (err) {
            logger('password verification error', err);
            return {systemWideUserId: systemWideUserId, verified: false, reason: err.message};
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
    };
};
