'use strict';

const logger = require('debug')('jupiter:rds:secrets');

// In this sample we only handle the specific exceptions for the 'GetSecretValue' API.
// See https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
// We rethrow the exception by default.

module.exports.handleSecretsErr = (err) => {
    logger('Error fetching secret: ', err);
    if (err.code === 'DecryptionFailureException') {
        // Secrets Manager can't decrypt the protected secret text using the provided KMS key.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    } else if (err.code === 'InternalServiceErrorException') {
        // An error occurred on the server side.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    } else if (err.code === 'InvalidParameterException') {
        // You provided an invalid value for a parameter.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;  
    } else if (err.code === 'InvalidRequestException') {
        // You provided a parameter value that is not valid for the current state of the resource.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    } else if (err.code === 'ResourceNotFoundException') {
        // We can't find the resource that you asked for.
        // Deal with the exception here, and/or rethrow at your discretion.
        throw err;
    }
};
