'use strict';

const logger = require('debug')('pluto:rds-common:int-test');
const config = require('config');

const RdsConnection = require('../index');

describe('Execute all on happy paths', () => {

    var rdsClient;

    before(() => {
        // rdsClient = new RdsConnection(config.get('db.testDb'), config.get('db.testUser'), config.get('db.testPassword'));
    });

    after(async () => {
        // await rdsClient.endPool();
    });

    it('Establish a connection properly and perform a basic select', async () => {
        // const testResult = await rdsClient.testPool();
    });

    /**
     * Test the main CRU(D) queries. Note we do not test delete because we don't expose it, because there is and should not
     * be a case for data deletion, for the moment (and probably forever).
     */

    it('Run select queries and retrieve results', async () => {
        
    });

    it('Run inserts, single and batch, and check results', async () => {

    });

    it('Run an update, single, and check results', async () => {

    });

});