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
        if (!systemWideUserId || !password) throw new Error('Invalid arguments passed to verifyPassword()')
        logger('recieved params:', systemWideUserId, password.length)
        const clientEphemeral = srp.generateEphemeral();
        logger('generated client ephemeral:', clientEphemeral);
        let saltAndServerPublicEphemeralJson = await verifierHelper.getSaltAndServerPublicEphemeral(systemWideUserId);
        logger('got the following values for salt and server public ephemeral:', saltAndServerPublicEphemeralJson)
        const saltAndServerPublicEphemeral = JSON.parse(saltAndServerPublicEphemeralJson);
        if (saltAndServerPublicEphemeral.reason) throw new Error(saltAndServerPublicEphemeral.reason);
        const salt = saltAndServerPublicEphemeral.salt;
        const serverPublicEphemeral = saltAndServerPublicEphemeral.serverPublicEphemeral;
        logger(salt, serverPublicEphemeral);
        const privateKey = srp.derivePrivateKey(salt, systemWideUserId, password);
        logger('derived private key:', privateKey.length);
        const clientSession = srp.deriveSession(clientEphemeral.secret, serverPublicEphemeral, salt, systemWideUserId, privateKey);
        logger('args passed to clientSession generator:', clientEphemeral.secret.length, '|', serverPublicEphemeral, '|', salt, '|', systemWideUserId, '|',  privateKey);
        logger('generated client session:', clientSession);
        try {
            const serverSessionProofJson = await verifierHelper.getServerSessionProof(systemWideUserId, clientSession.proof, clientEphemeral.public);
            logger('second server response:', serverSessionProofJson);
            const serverSessionProof = JSON.parse(serverSessionProofJson);
            if (serverSessionProof.serverSessionProof == null) throw new Error(serverSessionProof.reason);
            logger('server session proof object keys:', Object.keys(serverSessionProof));
            // srp.verifySession throws error on invalid password
            srp.verifySession(clientEphemeral.public, clientSession, serverSessionProof.serverSessionProof);
            return { systemWideUserId: systemWideUserId, verified: true };
        } catch (err) {
            logger('password verification error', err);
            return { systemWideUserId: systemWideUserId, verified: false, reason: err.message };
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { systemWideUserId: systemWideUserId, verified: false, reason: err.message }
    };
};
