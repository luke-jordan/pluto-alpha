'use strict';

// const logger = require('debug')('pluto:account:test');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

// const testHelper = require('./test.helper');

const proxyquire = require('proxyquire');

const insertStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertStub;
    }
}

const rds = proxyquire('../persistence/rds', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => {
    insertStub.reset();
};

const config = require('config');

describe('Marshalls account insertion properly', () => {

    beforeEach(() => resetStubs());

    it('Marshalls happy path account insertion properly', async () => {
        const testAccountDetails = {
            accountId: uuid(),
            clientId: 'zar_savings_co',
            defaultFloatId: 'zar_cash_float',
            ownerUserId: uuid(), 
            userFirstName: 'Luke',
            userFamilyName: 'Jordan'
        };

        const expectedQuery = `insert into ${config.get('tables.accountData')} ` + 
            `(account_id, responsible_client_id, default_float_id, owner_user_id, opening_user_id, user_first_name, user_last_name) ` + 
            `values %L returning account_id, creation_time`;
        const expectedColumns = '${accountId}, ${clientId}, ${defaultFloatId}, ${ownerUserId}, ${openingUserId}, ${userFirstName}, ${userFamilyName}';
        const expectedRow = JSON.parse(JSON.stringify(testAccountDetails));
        expectedRow.openingUserId = testAccountDetails.ownerUserId;
        
        const timeNow = new Date();
        insertStub.withArgs(expectedQuery, expectedColumns, sinon.match([expectedRow])).
            resolves({ rows: [
                {
                    'account_id': testAccountDetails.accountId, 
                    'creation_time': timeNow 
                }
            ]});
    
        const insertedAccount = await rds.insertAccountRecord(testAccountDetails);
        
        expect(insertedAccount).to.exist;
        expect(insertedAccount).to.have.property('accountId', testAccountDetails.accountId);
        expect(insertedAccount).to.have.property('persistedTime', timeNow);
    });

});
