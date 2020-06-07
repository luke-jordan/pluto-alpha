'use strict';

const logger = require('debug')('jupiter:boosts:tests');
const stringify = require('json-stable-stringify');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.wrapEvent = (requestBody, systemWideUserId, userRole) => ({
    body: JSON.stringify(requestBody),
    requestContext: {
        authorizer: {
            systemWideUserId,
            role: userRole
        }
    }
});

module.exports.wrapQueryParamEvent = (requestBody, systemWideUserId, userRole) => ({
    queryStringParameters: requestBody,
    requestContext: {
        authorizer: {
            systemWideUserId,
            userRole
        }
    }
});

module.exports.expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

module.exports.standardOkayChecks = (result, includeHeaders = false) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', 200);
    expect(result).to.have.property('body');
    if (includeHeaders) {
        expect(result.headers).to.deep.equal(exports.expectedHeaders);
    }
    return JSON.parse(result.body);
};

module.exports.logNestedMatches = (expectedObj, passedToArgs) => {
    Object.keys(expectedObj).forEach((key) => {
        const doesItMatch = sinon.match(expectedObj[key]).test(passedToArgs[key]);
        logger(`Key: ${key}, matches: ${doesItMatch}`);
        if (!doesItMatch) {
            logger('Not matched, expected: ', expectedObj[key], ' and passed: ', passedToArgs[key]);
        }
    });
};

module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: stringify(payload)
});

module.exports.mockLambdaResponse = (body, statusCode = 200) => ({
    Payload: JSON.stringify({
        statusCode,
        body: JSON.stringify(body)
    })
});

module.exports.createUUIDArray = (arraySize) => {
    const uuidArray = [];
    while (uuidArray.length < arraySize) {
        uuidArray.push(uuid());
    }
    return uuidArray;
};
