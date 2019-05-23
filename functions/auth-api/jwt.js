const logger = require('debug')('pluto:auth:jwt')

const fs = require('fs');
const jwt = require('jsonwebtoken');

var publicKey = fs.readFileSync('./public.key', 'utf8'); // read from s3/RDS/dynamo
var privateKey = fs.readFileSync('./private.key', 'utf8'); // read from s3/RDS/dynamo

module.exports.generateJsonWebToken = (payload, $Options) => {
    const signOptions = {
        issuer: $Options.issuer,
        subject: $Options.subject,
        audience: $Options.audience,
        expiresIn: "180d",
        algorithm: "RS256"
    };
    return jwt.sign(payload, privateKey, signOptions);
 };


module.exports.verifyJsonWebToken = (token, $Options) => {
    logger('Public key? :', publicKey);

    const verifyOptions = {
        issuer: $Options.issuer,
        subject: $Options.subject,
        audience: $Options.audience,
        expiresIn: "180d",
        algorithm: ["RS256"]
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
    // returns null if token is invalid
};   
