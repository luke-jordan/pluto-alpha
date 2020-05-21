'use strict';

const uuid = require('uuid/v4');

const helper = require('./test-helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire').noCallThru();

const simpleInsertStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();

const queryStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor() {
        this.selectQuery = queryStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const persistenceWrite = proxyquire('../persistence/write.friends', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub 
});

const persistenceRead = proxyquire('../persistence/read.friends', {
    'rds-common': MockRdsConnection
});

describe('*** UNIT TEST FRIEND SAVING PERSISTENCE, WRITES ***', async () => {

    it('Creates a new saving pot', async () => {
        
    });

    it('Updates a saving pot name', async () => {

    });

    it('Adds someone to a saving pot', async () => {

    });

});

describe('**** UNIT TEST FRIEND SAVING PERSISTENCE, READS ***', async () => {

    it('Finds savings pots (basic details) that user is part of', async () => {

    });

    it('Calculates balance of set of savings pots', async () => {

    });

    it('Gets history (all relevant info) on set of savings pots', async () => {

    });

});
