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

module.exports.checkErrorResultForMsg = (errorResult, expectedErrorMsg) => {
    expect(errorResult).to.exist;
    expect(errorResult).to.have.property('statusCode', 400);
    expect(errorResult.body).to.equal(expectedErrorMsg);
};

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.standardOkayChecks = (result) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', 200);
    expect(result).to.have.property('body');
    return JSON.parse(result.body);
};

module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: JSON.stringify(payload)
});

module.exports.mockLambdaResponse = (payload) => ({
    StatusCode: 200,
    Payload: payload
});

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
