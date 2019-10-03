'use strict';

const logger = require('debug')('jupiter:account:test');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

// const testHelper = require('./test.helper');

const proxyquire = require('proxyquire');

const insertStub = sinon.stub();
const queryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertStub;
        this.selectQuery = queryStub;
    }
}

const rds = proxyquire('../persistence/rds', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => {
    insertStub.reset();
    queryStub.reset();
};

const config = require('config');

describe('Marshalls account insertion properly', () => {

    beforeEach(() => resetStubs());

    it('Marshalls happy path account insertion properly', async () => {
        const testAccountDetails = {
            accountId: uuid(),
            clientId: 'zar_savings_co',
            defaultFloatId: 'zar_cash_float',
            ownerUserId: uuid()
        };

        const expectedQuery = `insert into ${config.get('tables.accountData')} ` + 
            `(account_id, responsible_client_id, default_float_id, owner_user_id, opening_user_id) ` + 
            `values %L returning account_id, creation_time`;
        const expectedColumns = '${accountId}, ${clientId}, ${defaultFloatId}, ${ownerUserId}, ${openingUserId}';
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

    it('Uses default account details where not provided', async () => {
        const testAccountDetails = { 
            'accountId': 'a9a87bce-2681-406a-9bb7-3d20cf385e86',
            'clientId': 'zar_savings_co',
            'defaultFloatId': 'zar_cash_float',
            'ownerUserId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78'
        };

        const expectedQuery = `insert into ${config.get('tables.accountData')} ` + 
            `(account_id, responsible_client_id, default_float_id, owner_user_id, opening_user_id) ` + 
            `values %L returning account_id, creation_time`;
        const expectedColumns = '${accountId}, ${clientId}, ${defaultFloatId}, ${ownerUserId}, ${openingUserId}';
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
    
        const insertedAccount = await rds.insertAccountRecord();
        
        expect(insertedAccount).to.exist;
        expect(insertedAccount).to.have.property('accountId', testAccountDetails.accountId);
        expect(insertedAccount).to.have.property('persistedTime', timeNow);
    });

    it('Gets user account id properly', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();
        const accQuery = `select account_id from ${config.get('tables.accountData')} where owner_user_id = $1 order by creation_time desc limit 1`
        queryStub.withArgs(accQuery, [testUserId]).resolves([{ 'account_id': testAccountId }]);

        const retrievedAccId = await rds.getAccountIdForUser(testUserId);

        expect(retrievedAccId).to.exist;
        expect(retrievedAccId).to.deep.equal(testAccountId);
        expect(queryStub).to.have.been.calledOnceWithExactly(accQuery, [testUserId]);
    });

    it('Returns undefined where account id is not found', async () => {
        const testUserId = uuid();
        const testAccountId = uuid();
        const accQuery = `select account_id from ${config.get('tables.accountData')} where owner_user_id = $1 order by creation_time desc limit 1`
        queryStub.withArgs(accQuery, [testUserId]).resolves([]);

        const retrievedAccId = await rds.getAccountIdForUser(testUserId);

        expect(retrievedAccId).to.be.undefined;
        expect(queryStub).to.have.been.calledOnceWithExactly(accQuery, [testUserId]);
    });

});
