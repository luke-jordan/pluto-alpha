'use strict';

const logger = require('debug')('jupiter:admin:float-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const dynamo = proxyquire('../persistence/dynamo.float', {

});

describe('*** UNIT TEST DYNAMO FLOAT ***', () => {


    it('Lists country clients', async () => {

    });

    it('Lists client floats', async () => {

    });

    it('Fetches client float variables', async () => {
        
    });
});