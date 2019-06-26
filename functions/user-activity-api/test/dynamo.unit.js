'use strict';

const logger = require('debug')('pluto:activity:test');

process.env.NODE_ENV = 'test';

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;

const proxyquire = require('proxyquire');
const fetchStub = sinon.stub();

const dynamo = require('../persistence/dynamodb', {
    'dynamo-common': {
        fetchSingleRow: fetchStub
    },
    '@noCallThru': true
});

describe('** UNIT TESTING DYNAMO FETCH **', () => {

    beforeEach(() => fetchStub.reset());

    it('Fetches paramaters correctly when passed both IDs', () => {
        
    });

    it('Returns gracefully when cannot find variables for client/float pair', () => {

    });

    it('Throws an error when missing one of the two needed IDs', () => {

    });

});