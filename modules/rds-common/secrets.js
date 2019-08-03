'use strict'

// const config = require('config');
const logger = require('debug')('jupiter:rds:secrets');

// Load the AWS SDK
const AWS = require('aws-sdk');

// Create a Secrets Manager client
var client = new AWS.SecretsManager({
    region: 'us-east-1'
});

// In this sample we only handle the specific exceptions for the 'GetSecretValue' API.
// See https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
// We rethrow the exception by default.

const handleSecretsErr  =(err) => {
    logger('Error fetching secret: ', err);
    if (err.code === 'DecryptionFailureException')
        // Secrets Manager can't decrypt the protected secret text using the provided KMS key.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    else if (err.code === 'InternalServiceErrorException')
        // An error occurred on the server side.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    else if (err.code === 'InvalidParameterException')
        // You provided an invalid value for a parameter.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    else if (err.code === 'InvalidRequestException')
        // You provided a parameter value that is not valid for the current state of the resource.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    else if (err.code === 'ResourceNotFoundException')
        // We can't find the resource that you asked for.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
}

module.exports.getSecretForUser = (rdsUserName, callback) => {
    const secretName = config.get(`secret.names.${rdsUserName}`);
    logger('Fetching secret with name: ', secretName);
    client.getSecretValue(secretName, (err, fetchedSecretData) => {
        if (err) {
            handleSecretsErr(err);
            callback(null); // in case we don't throw
        }
        // Decrypts secret using the associated KMS CMK.
        // Depending on whether the secret is a string or binary, one of these fields will be populated.
        logger('No error, got the secret, moving onward: ', fetchedSecretData);
        if ('SecretString' in fetchedSecretData) {
            secret = data.SecretString;
            callback(secret);
        } else {
            let buff = new Buffer(fetchedSecretData.SecretBinary, 'base64');
            decodedBinarySecret = buff.toString('ascii');
            callback(decodedBinarySecret);
        }
    });  
};
