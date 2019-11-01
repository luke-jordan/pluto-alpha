'use strict';

const logger = require('debug')('jupiter:admin:rds-float-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const queryStub = sinon.stub();
const updateRecordStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        // this.selectQuery = queryStub;
        // this.updateRecord = updateRecordStub;
        // this.insertRecords = insertRecordsStub;
    }
}

const persistence = proxyquire('../persistence/rds.float', {
    'rds-common': MockRdsConnection
});

describe('*** UNIT TEST RDS FLOAT FUNCTIONS ***', () => {

    it('Gets float balance', async () => {

    });

    it('Gets float allocated total', async () => {

    });

    it('Gets user allocation and accounts transactions', async () => {

    });

    it('Gets float bonus balance', async () => {

    });

    it('Gets last float accrual time', async () => {

    });

    it('Gets float alerts', async () => {

    });

    it('Inserts float log', async () => {

    });

    it('Updates float log', async () => {

    });
});