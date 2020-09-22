'use strict';

const logger = require('debug')('jupiter:admin:test-helper');
const stringify = require('json-stable-stringify');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.expectNoCalls = (...stubs) => {
    stubs.forEach((stub) => expect(stub).to.not.have.been.called);
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

module.exports.wrapPathEvent = (body, userId, pathSegment, role = 'SYSTEM_ADMIN') => {
    const wrappedEvent = exports.wrapEvent(body, userId, role);
    if (pathSegment) {
        wrappedEvent.pathParameters = {
            proxy: pathSegment
        };
    }
    return wrappedEvent;
};

module.exports.wrapHttpPathEvent = (params, path, userId, userRole = 'SYSTEM_ADMIN') => ({
    requestContext: {
        authorizer: {
            systemWideUserId: userId,
            role: userRole
        }
    },
    httpMethod: 'POST',
    pathParameters: {
        proxy: path
    },
    body: JSON.stringify(params)
});

module.exports.wrapQueryParamEvent = (requestBody, systemWideUserId, userRole, httpMethod = 'GET') => ({
    queryStringParameters: requestBody,
    httpMethod: httpMethod,
    requestContext: {
        authorizer: {
            systemWideUserId,
            role: userRole
        }
    }
});

module.exports.expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

module.exports.standardOkayChecks = (result, checkHeaders = false) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', 200);
    expect(result).to.have.property('body');
    if (checkHeaders) {
        expect(result).to.have.property('headers');
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

module.exports.mockLambdaDirect = (result, statusCode = 200) => ({
    StatusCode: statusCode,
    Payload: JSON.stringify(result)
});
