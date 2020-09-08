'use strict';

const sinon = require('sinon');
const chai = require('chai');
const moment = require('moment');

const expect = chai.expect;

const logger = require('debug')('jupiter:existence:test');

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

module.exports.expectNoCalls = (...stubs) => {
    stubs.forEach((stub) => expect(stub).to.not.have.been.called);
};

module.exports.expectedHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

module.exports.standardOkayChecks = (result, includeHeaders) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', 200);
    expect(result).to.have.property('body');
    if (includeHeaders) {
        expect(result.headers).to.deep.equal(exports.expectedHeaders);
    }
    return JSON.parse(result.body);
};

module.exports.expectedErrorChecks = (result, expectedStatusCode) => {
    expect(result).to.exist;
    expect(result).to.have.property('statusCode', expectedStatusCode);
    expect(result).to.have.property('body');
    return JSON.parse(result.body);
};
