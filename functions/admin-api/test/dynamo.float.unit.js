'use strict';

const logger = require('debug')('jupiter:admin:dynamo-float-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const docClientGetStub = sinon.stub();
const docClientScanStub = sinon.stub();

class MockDocClient {
    constructor () {
        this.get = docClientGetStub;
        this.scan = docClientScanStub;
    }
}

const dynamo = proxyquire('../persistence/dynamo.float', {
    'aws-sdk': { DynamoDB: { DocumentClient: MockDocClient }},
    '@noCallThru': true
});

describe('*** UNIT TEST DYNAMO FLOAT ***', () => {
    
    it('Lists country clients', async () => {
        const expectedResult = { 'client_id': uuid() };
        docClientScanStub.returns({ promise: () => ({ Items: [expectedResult, expectedResult] })});

        const resultOfListing = await dynamo.listCountriesClients();
        logger('Result of country client listing:', resultOfListing);
    });

    it('Lists client floats', async () => {
        const expectedResult = { 'float_id': uuid() };
        docClientScanStub.returns({ promise: () => ({ Items: [expectedResult, expectedResult] })});

        const resultOfListing = await dynamo.listClientFloats();
        logger('Result of client float listing:', resultOfListing);
    });

    it('Fetches client float variables', async () => {
        const testClientId = uuid();
        const testFloatId = uuid();

        const expectedResult = { 'float_id': uuid(), 'client_id': uuid() };
        docClientGetStub.returns({ promise: () => ({ Item: [expectedResult] })});

        const clientFloatVars = await dynamo.fetchClientFloatVars(testClientId, testFloatId);
        logger('Result of client float listing:', clientFloatVars);
    });
});