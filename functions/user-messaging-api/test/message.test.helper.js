'use strict';

const logger = require('debug')('jupiter:boosts:tests');
const stringify = require('json-stable-stringify');
const decamelize = require('decamelize');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.wrapEvent = (requestBody, systemWideUserId, role) => ({
    body: JSON.stringify(requestBody),
    requestContext: {
        authorizer: {
            systemWideUserId,
            role
        }
    }
});

module.exports.extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

module.exports.extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');

module.exports.standardOkayChecks = (result, expectedResult) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', 200);
    expect(result).to.have.property('body');
    const parsedResult = JSON.parse(result.body);
    if (expectedResult) {
        expect(parsedResult).to.deep.equal(expectedResult);
    }
    return parsedResult;
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

module.exports.requestContext = (systemWideUserId) => ({
    authorizer: {
        systemWideUserId
    }
});

module.exports.expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: stringify(payload)
});

module.exports.mockLambdaResponse = (body, statusCode = 200) => ({
    StatusCode: statusCode,
    Payload: JSON.stringify(body)
});
