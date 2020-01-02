'use strict';

const sinon = require('sinon');
const chai = require('chai');
const moment = require('moment');

const expect = chai.expect;

const logger = require('debug')('jupiter:float:test');

module.exports.randomInteger = (base = 1) => Math.floor(Math.random() * base);

module.exports.commonFloatConfig = {
    bonusPoolShare: 1 / 7.25,
    bonusPoolTracker: 'zar_cash_bonus_pool',
    clientCoShare: 0.25 / 7.25,
    clientCoShareTracker: 'pluto_za_share'
};

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

module.exports.resetStubs = (...stubs) => stubs.forEach((stub) => stub.reset());
