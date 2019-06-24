'use strict';

const logger = require('debug')('pluto:auth:jwt-module-main')
const config = require('config');
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');
const s3 = require('./s3-util');

AWS.config.update({
    region: "us-east-1",
    // endpoint: "http://localhost:4572"
});


module.exports.generateJsonWebToken = async (payload, recievedSignOptions) => {
    try {
    logger('Running in jwt generation function with args:', payload, recievedSignOptions);
    if (!recievedSignOptions.issuer || 
        !recievedSignOptions.subject || 
        !recievedSignOptions.audience) throw new Error(`Invalid signOptions: ${recievedSignOptions}`);
    const signOptions = {
        issuer: recievedSignOptions.issuer,
        subject: recievedSignOptions.subject,
        audience: recievedSignOptions.audience,
        expiresIn: config.get('jwt.expiresIn'),
        algorithm: config.get('jwt.algorithm')
    };
    const privateKey = await s3.getPublicOrPrivateKey('jwt-private.key');
    logger(privateKey);
    return jwt.sign(payload, privateKey, signOptions);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {error: err.message};
    }
 };


module.exports.verifyJsonWebToken = async (token, recievedVerifyOptions) => {
    try {
        logger('running in jwt verification function');
        if (!recievedVerifyOptions.issuer || 
            !recievedVerifyOptions.subject || 
            !recievedVerifyOptions.audience) throw new Error(`Invalid verifyOptions: ${recievedVerifyOptions}`);
        const verifyOptions = {
            issuer: recievedVerifyOptions.issuer,
            subject: recievedVerifyOptions.subject,
            audience: recievedVerifyOptions.audience,
            expiresIn: config.get('jwt.expiresIn'),
            algorithm: config.get('jwt.algorithm')
        };
        const publicKey = await s3.getPublicOrPrivateKey('jwt-public.key');
        logger(publicKey);
        return jwt.verify(token, publicKey, verifyOptions);
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return {error: err.message}; // ensure all callers are aware of return object structure
    };
};


module.exports.decodeJsonWebToken = (token) => {
    return jwt.decode(token, {complete: true});
};   


// module.exports.refreshJsonWebToken = (token) => {
//     const decodedJwt = exports.decodeJsonWebToken(token);
//     extract payload
//     extract sign options
//     return exports.generateJsonWebToken(payload, signOPtions);
// };

