const logger = require('debug')('pluto:auth:jwt')
const config = require('config');

const fs = require('fs');
const jwt = require('jsonwebtoken');

const AWS = require('aws-sdk');
AWS.config.update({
    region: "us-east-1",
    endpoint: "http://localhost:8000"
});

const s3 = require('./s3Util');


module.exports.generateJsonWebToken = async (payload, $Options) => {
    logger('Running in jwt mod.');
    const signOptions = {
        issuer: $Options.issuer,
        subject: $Options.subject,
        audience: $Options.audience,
        expiresIn: config.get('jwt.expiresIn'),
        algorithm: config.get('jwt.algorithm')
    };
    const privateKey = await s3.getPublicOrPrivateKey('jwt-private.key', 'someAuthorisationKey');
    logger(privateKey);
    return jwt.sign(payload, privateKey, signOptions);
 };


module.exports.verifyJsonWebToken = async (token, $Options) => {
    logger('Public key? :', publicKey);

    const verifyOptions = {
        issuer: $Options.issuer,
        subject: $Options.subject,
        audience: $Options.audience,
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

