'use strict';

const chai = require('chai');
const expect = chai.expect;

module.exports.expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.expectNoCalls = (...stubs) => {
    stubs.forEach((stub) => expect(stub).to.not.have.been.called);
};

module.exports.standardOkayChecks = (result, statusCode = 200) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', statusCode);
    expect(result).to.have.property('body');

    if (result.headers) {
        expect(result.headers).to.deep.equal(exports.expectedHeaders);
    }
    
    return JSON.parse(result.body);
};

module.exports.wrapEvent = (requestBody, systemWideUserId, userRole = 'ORDINARY_USER') => ({
    body: JSON.stringify(requestBody),
    requestContext: {
        authorizer: {
            systemWideUserId,
            role: userRole
        }
    }
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

module.exports.wrapResponse = (body, statusCode = 200) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
});
