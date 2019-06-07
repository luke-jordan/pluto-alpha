const logger = require('debug')('pluto:auth-jwt-λ:main')
const config = require('config');

const fs = require('fs');
const jwt = require('jsonwebtoken');

const AWS = require('aws-sdk');
AWS.config.update({
    region: "us-east-1",
    // endpoint: "http://localhost:4572"
});

const s3 = require('../utils/s3-util');


module.exports.generateJsonWebToken = async (payload, recievedSignOptions) => {
    logger('Running in jwt mod.');
    const signOptions = {
        issuer: recievedSignOptions.issuer,
        subject: recievedSignOptions.subject,
        audience: recievedSignOptions.audience,
        expiresIn: config.get('jwt.expiresIn'),
        algorithm: config.get('jwt.algorithm')
    };
    const privateKey = await s3.getPublicOrPrivateKey('jwt-private.key', 'someAuthorisationKey');
    logger(privateKey);
    return jwt.sign(payload, privateKey, signOptions);
 };


module.exports.verifyJsonWebToken = async (token, recievedVerifyOptions) => {
    logger('Public key? :', publicKey);

    const verifyOptions = {
        issuer: recievedVerifyOptions.issuer,
        subject: recievedVerifyOptions.subject,
        audience: recievedVerifyOptions.audience,
        expiresIn: config.get('jwt.expiresIn'),
        algorithm: config.get('jwt.algorithm')
    };

    try {
        const publicKey = await s3.getPublicOrPrivateKey('jwt-public.key', 'someAuthorisationKey');
        logger(publicKey);
        return jwt.verify(token, publicKey, verifyOptions);
    }
    catch (err) {
        logger('Error: ', err);
        return false;
    };
};


module.exports.decodeJsonWebToken = (token) => {
    return jwt.decode(token, {complete: true});
};   


module.exports.refreshJsonWebToken = (token) => {
    const decodedJwt = exports.decodeJsonWebToken(token);
    // extract payload
    // extract sign options
    return exports.generateJsonWebToken(payload, signOPtions);
};

