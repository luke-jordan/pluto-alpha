'use strict';

const logger = require('debug')('jupiter:lambda:warmup');
const config = require('config');

const AWS = require('aws-sdk');
const endpoint = config.has('aws.endpoints.lambda') ? config.get('aws.endpoints.lambda') : null;
const lambda = new AWS.Lambda({ region: config.get('aws.region'), endpoint });

const invokeFunctionPromise = (functionName) => lambda.invoke({
    FunctionName: functionName,
    InvocationType: 'Event',
    LogType: 'None'
}).promise();

module.exports.handler = async (context) => {
    const invocations = config.get('lambdas').map((name) => invokeFunctionPromise(name));
    const resultOfFiringOff = await Promise.all(invocations);
    logger('Result: ', resultOfFiringOff);
    const response = {
        statusCode: 200,
        body: JSON.stringify('Lambdas warmed!'),
    };
    return response;
};

// exports.handler();