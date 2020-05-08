'use strict';

const chai = require('chai');
chai.use(require('sinon-chai'));
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

module.exports.wrapParamsWithPath = (params, path, systemWideUserId) => ({
    requestContext: {
        authorizer: {
            systemWideUserId
        }
    },
    httpMethod: 'POST',
    pathParameters: {
        proxy: path
    },
    body: JSON.stringify(params)
});

module.exports.wrapResponse = (body, statusCode = 200) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
});

module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: JSON.stringify(payload)
});

module.exports.mockLambdaResponse = (body, statusCode = 200) => ({
    Payload: JSON.stringify({
        statusCode,
        body: JSON.stringify(body)
    })
});

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
