const logger = require('debug')('pluto:auth:jwt')
const config = require('config');

const fs = require('fs');
const jwt = require('jsonwebtoken');

var publicKey = fs.readFileSync('./public.key', 'utf8'); // read from s3/RDS/dynamo
var privateKey = fs.readFileSync('./private.key', 'utf8'); // read from s3/RDS/dynamo

module.exports.generateJsonWebToken = (payload, $Options) => {
    const signOptions = {
        issuer: $Options.issuer,
        subject: $Options.subject,
        audience: $Options.audience,
        expiresIn: config.get('jwt.expiresIn'),
        algorithm: config.get('jwt.algorithm')
    };
    return jwt.sign(payload, privateKey, signOptions);
 };


module.exports.verifyJsonWebToken = (token, $Options) => {
    logger('Public key? :', publicKey);

    const verifyOptions = {
        issuer: $Options.issuer,
        subject: $Options.subject,
        audience: $Options.audience,
        expiresIn: config.get('jwt.expiresIn'),
        algorithm: config.get('jwt.algorithm')
    };

    try {
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
}