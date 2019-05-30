const srp = require('secure-remote-password/client');
const logger = require('debug')('pluto:auth:pwdalgo')

/**
 * This is the primary module shared between all lambdas serving some function of the current
 * implementation of the secure remote password protocol.
 */


// This function is used exclusively by the sign up lambda.
module.exports.generateSaltAndVerifier = (systemWideUserId, password) => {
    if (systemWideUserId && password) {
        const salt = srp.generateSalt();
        const privateKey = srp.derivePrivateKey(salt, systemWideUserId, password);
        const verifier = srp.deriveVerifier(privateKey);

        return { systemWideUserId, salt, verifier };
    }
    return {error: 'Invalid input'};
};


// all functions below handle user login
module.exports.loginExistingUser = (systemWideUserId, password) => {
    const clientEphemeral = srp.generateEphemeral()
    const response = exports.loginHelper('saltAndServerPublicEphemeralLambdaUrl', {
        systemWideUserId: systemWideUserId,
        clientPublicEphemeral: clientEphemeral.public
    });
    logger('first server response:', response)
    if (!response) return {systemWideUserId: systemWideUserId, verified: false, reason: 'No response from server'};
    salt = response.salt;
    serverPublicEphemeral = response.serverEphemeralPublic;
    const privateKey = srp.derivePrivateKey(salt, systemWideUserId, password);
    const clientSession = srp.deriveSession(clientEphemeral.secret, serverPublicEphemeral, salt, systemWideUserId, privateKey);
    logger('args passed to clientSession generator:', clientEphemeral.secret, '|', serverPublicEphemeral, '|', salt, '|', systemWideUserId, '|',  privateKey);
    const serverResponse = exports.loginHelper('serverSessionProofLambdaUrl', {
        systemWideUserId: systemWideUserId,
        clientSessionProof: clientSession.proof,
        clientPublicEphemeral: clientEphemeral.public
    });
    logger('second server response:', serverResponse);
    try {
        if (!serverResponse) throw new Error('Server session proof not recieved')
        srp.verifySession(clientEphemeral.public, clientSession, serverResponse.serverSessionProof);
        return {systemWideUserId: systemWideUserId, verified: true};
    }
    catch (err) {
        return {systemWideUserId: systemWideUserId, verified: false, reason: err.message};
    };
};


module.exports.loginHelper = (targetLambda, params) => {
    // query target lambda with params. 
    // return response
};


// Then next two functions are run on the database facing lambdas. They are in turn called by the 
// login lambda during user login. Their job is to store and retrive data to be persisted.
// The parameters in this function are unpacked from the lambdas event.
module.exports.getSaltAndServerPublicEphemeral = (systemWideUserId, clientPublicEphemeral) => {
    // const userDetails = rds.getUserDetails(systemWideUserId);
    // const salt = userDetails.salt;
    // const verifier = userDetails.verifier; 
    // const serverEphemeral = srp.generateEphemeral(verifier);
    // userDetails.serverEphemeralSecret = serverEphemeral.secret;
    // update pesisted userDetails with new object created on the line above.
    // return JSON.stringify({
    //     salt: salt,
    //     serverPublicEphemeral: serverEphemeral.public 
    // });
};


// This function fetches the final piece of data needed during secure remote password protocl verification
module.exports.getServerSessionProof = (systemWideUserId, clientSessionProof, clientPublicEphemeral) => {
    // const userDetails = rds.getUserDetails(systemWideUserId);
    // const serverEphemeralSecret = userDetails.serverEphemeralSecret;
    // const salt = userDetails.salt;
    // const verifier = userDetals.verifier;
    // const serverSession = srp.deriveSession(
    //     serverEphemeralSecret,
    //     clientPublicEphemeral,
    //     salt,
    //     systemWideUserId,
    //     verifier,
    //     clientSessionProof
    // );
    // return JSON.stringify({
    //     serverSessionProof: serverSession.proof    
   //  });
};
