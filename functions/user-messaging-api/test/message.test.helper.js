'use strict';

const logger = require('debug')('jupiter:boosts:tests');
// const stringify = require('json-stable-stringify');

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
            userRole
        }
    }
});

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

/*
    const commonAssertions = (statusCode, result, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };
*/

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

// module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
//     FunctionName: functionName,
//     InvocationType: async ? 'Event' : 'RequestResponse',
//     Payload: stringify(payload)
// });

// module.exports.mockLambdaResponse = (body, statusCode = 200) => ({
//     Payload: JSON.stringify({
//         statusCode,
//         body: JSON.stringify(body)
//     })
// });
