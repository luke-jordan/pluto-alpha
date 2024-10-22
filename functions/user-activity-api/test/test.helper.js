'use strict';

const sinon = require('sinon');
const chai = require('chai');
const moment = require('moment');

const expect = chai.expect;

const logger = require('debug')('jupiter:user-activity:test');

module.exports.momentMatcher = (testMoment) => sinon.match((value) => moment.isMoment(value) && testMoment.isSame(value));

module.exports.anyMoment = sinon.match((value) => moment.isMoment(value));

module.exports.logNestedMatches = (expectedObj, passedToArgs) => {
    Object.keys(expectedObj).forEach((key) => {
        const doesItMatch = sinon.match(expectedObj[key]).test(passedToArgs[key]);
        logger(`Key: ${key}, matches: ${doesItMatch}`);
        if (!doesItMatch) {
            logger('Not matched, expected: ', expectedObj[key], ' and passed: ', passedToArgs[key]);
        }
    });
};

module.exports.expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

module.exports.checkErrorResultForMsg = (errorResult, expectedErrorMsg) => {
    expect(errorResult).to.exist;
    expect(errorResult).to.have.property('statusCode', 400);
    expect(errorResult.body).to.equal(expectedErrorMsg);
};

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.expectNoCalls = (...stubs) => {
    stubs.forEach((stub) => expect(stub).to.not.have.been.called);
};

module.exports.wrapEvent = (requestBody, systemWideUserId, userRole = 'ORDINARY_USER') => ({
    httpMethod: 'POST',
    body: JSON.stringify(requestBody),
    requestContext: {
        authorizer: {
            systemWideUserId,
            role: userRole
        }
    }
});

module.exports.standardOkayChecks = (result, statusCode = 200) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', statusCode);
    expect(result).to.have.property('body');

    if (result.headers) {
        expect(result.headers).to.deep.equal(exports.expectedHeaders);
    }
    
    return JSON.parse(result.body);
};

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

module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: JSON.stringify(payload)
});

module.exports.mockLambdaResponse = (payload) => ({
    StatusCode: 200,
    Payload: payload // stringify ?
});

module.exports.normalizeHistory = (events) => {
    const result = [];
    events.forEach((event) => {
        result.push({
            timestamp: event.timestamp,
            type: 'HISTORY',
            details: {
                initiator: event.initiator,
                context: event.context,
                interface: event.interface,
                eventType: event.eventType
            }
        });
    });
    return result;
};

module.exports.normalizeTx = (events) => {
    const result = [];
    events.forEach((event) => {
        result.push({
            timestamp: moment(event.creationTime).valueOf(),
            type: 'TRANSACTION',
            details: {
                transactionId: event.transactionId,
                accountId: event.accountId,
                transactionType: event.transactionType,
                settlementStatus: event.settlementStatus,
                amount: event.amount,
                currency: event.currency,
                unit: event.unit,
                humanReference: event.humanReference
            }
        });
    });
    return result;
};

module.exports.testLambdaInvoke = (lambdaStub, requiredInvocation) => {
    expect(lambdaStub).to.have.been.calledOnce;
    const lambdaArgs = lambdaStub.getCall(0).args;
    expect(lambdaArgs.length).to.equal(1);
    const lambdaInvocation = lambdaArgs[0];
    expect(lambdaInvocation).to.have.property('FunctionName', requiredInvocation['FunctionName']);
    expect(lambdaInvocation).to.have.property('InvocationType', requiredInvocation['InvocationType']);
    const expectedPayload = JSON.parse(requiredInvocation['Payload']);
    const argumentPayload = JSON.parse(lambdaInvocation['Payload']);
    expect(argumentPayload).to.deep.equal(expectedPayload);
};
