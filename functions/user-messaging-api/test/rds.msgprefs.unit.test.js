'use strict';

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const helper = require('./message.test.helper');

const rdsGetStub = sinon.stub();
const rdsInsertStub = sinon.stub();
const rdsUpdateStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = rdsGetStub;
        this.insertRecords = rdsInsertStub;
        this.updateRecordObject = rdsUpdateStub;
    }
}

const proxyquire = require('proxyquire');

const rdsPreferences = proxyquire('../persistence/rds.pushsettings.js', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

describe('*** UNIT TEST MSG PREFS PERSISTENCE', async () => {

    beforeEach(() => helper.resetStubs(rdsGetStub, rdsInsertStub, rdsUpdateStub));

    it('Retrieves user messaging preferences', async () => {

    });

    it('Inserts user messaging preferences', async () => {

    });

    it('Updates user messaging preferences', async () => {

    });

});
