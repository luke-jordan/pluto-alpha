'use strict';

const logger = require('debug')('pluto:rds-common:int-test');
const config = require('config');

const chai = require('chai');
const expect = chai.expect;

const randomWords = require('random-words');

const RdsConnection = require('../index');

// note: only to be used for 

const { Pool } = require('pg');
const pool = new Pool({
    host: config.get('db.host'),
    port: config.get('db.port'),
    user: config.get('db.testUser'),
    database: config.get('db.testDb'),
    password: config.get('db.testPassword')
});

const createFreshDb = async (done) => {
    const client = await pool.connect();
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO postgres');
    client.query('GRANT ALL ON SCHEMA public TO public', (err, res) => {
        if (err) {
            logger('Error creating clean copy of DB!');
        } else {
            logger('Clean copy of DB created, proceeding');
            done();
        }
    });
}

const setupTables = async (done) => {
    const client = await pool.connect();
    await client.query('create table account (id serial not null primary key, creation_time timestamp not null default current_timestamp, name varchar(50), balance int)');
    await client.query('insert into account (name) values ($1), ($2) returning id', ['tester', 'other']);

    await createLedgerTable('ledger_1', client);
    await createLedgerTable('ledger_2', client);
    await createLedgerTable('ledger_3', client);
    
    // logger('Query result: ', singleAccount);
    await client.release();
    done();
}

const createLedgerTable = async (ledgerName, client) => {
    if (!client) {
        client = await pool.connect();
    }
    // todo maybe have an option to drop and recreate if exists
    await client.query(`create table if not exists ${ledgerName} (id serial not null primary key, creation_time timestamp not null default current_timestamp, account_id integer references account(id), amount bigint)`); 
}

const endPools = (rdsClient, done) => {
    rdsClient.endPool().then(() => {
        logger("Finished RDS client, doing next");
        pool.end().then(() => {
            logger('Should be shut down now');
            done();
        });
    });
}

describe('Execute all on happy paths', function () {

    // this.timeout(5000);

    var rdsClient;

    before((done) => {
        rdsClient = new RdsConnection(config.get('db.testDb'), config.get('db.testUser'), config.get('db.testPassword'));
        createFreshDb(() => setupTables(done));
    });

    // ugh, mocha lousiness on async means this is causing all sorts of problems, so removing
    after((done) => {
        logger('What is happening?');
        // pool.end(done);
        endPools(rdsClient, done);
    });

    it('Establish a connection properly and perform a basic select', async () => {
        const testResult = await rdsClient.testPool();
        expect(testResult).to.exist;
        expect(testResult).to.eql([{'?column?': 1 }]);
    });

    /**
     * Test the main CRU(D) queries. Note we do not test delete because we don't expose it, because there is and should not
     * be a case for data deletion, for the moment (and probably forever).
     */
    it('Run select queries and retrieve results', async () => {
        const numAccounts = 1;

        await createBunchOfAccounts(numAccounts);
        const transValues = await insertBatchOfRecords('ledger_1', 2, 100); // store that
        await rdsClient.insertRecords(`insert into ledger_1 (account_id, amount) values $1`, transValues);

        const sumOfAmounts = sumForAccount(transValues, 1);

        await insertBatchOfRecords('ledger_2', 3, 200); // store that

        const calculationResult1 = await rdsClient.selectQuery('select sum(amount) from ledger_1 where account_id = $1', [1]);
        const calculationResult2 = await rdsClient.selectQuery('select count(distinct(account_id)) from ledger_2', []);

        logger('Calculation result 1: ', calculationResult1);
        logger('Calculation result 2: ', calculationResult2);

        expect(calculationResult1).to.exist;
        expect(calculationResult2).to.exist;
        
        expect(calculationResult1).to.be.an('array');
        expect(calculationResult1[0]).to.have.property('sum');
        expect(calculationResult1[0]['sum']).to.equal(sumOfAmounts);

        expect(calculationResult2).to.be.an('array');
        expect(calculationResult2[0]).to.have.property('count');
        expect(calculationResult2[0]['count']).to.equal(numAccounts);
    });

    it('Run single insert', async () => {
        const numAccounts = 1; // just to make sure at least one exists
        await createBunchOfAccounts(numAccounts);
        
        const singleTransaction = await rdsClient.insertRecords('insert into ledger_2 (account_id, amount) values $1 returning id', 
            { 'account_id': 1, 'amount': 234 });
        
        expect(singleTransaction).to.exist;
        expect(singleTransaction).to.have.property('rows');
        expect(singleTransaction['rows']).to.be.an('array').of.length(1);
        expect(singleTransaction['rows'][0]).to.have.property('id');
        
        const transactionId = singleTransaction['rows'][0]['id'];
        expect(transactionId).to.be.a('number');

        const returnRows = await rdsClient.slectQuery('select * from ledger_2 where id = $1', [transactionId]);
        expect(returnRows).to.exist;
        
        const record = returnRows[0];
        expect(record).to.have.property('id');
        expect(record).to.have.property('creation_time');
        expect(record['account_id']).to.equal(1);
        expect(record['amount']).to.equal(234);
    });

    it('Run big batch of inserts', async () => {
        const numAccounts = 1e4;
        await createBunchOfAccounts(numAccounts);
        
        const bigBatchTransactions = await insertBatchOfRecords(1, 100);
        const transIds = await rdsClient.insertRecords(`insert into ledger_3 (account_id, amount) values $1 returning id`, bigBatchTransactions);

        expect(transIds).to.exist;
        expect(transIds).to.be.an('array');
        expect(transIds.length).to.equal(bigBatchTransactions[0].length);

        const sumOfAmounts = bigBatchTransactions[0].map(trans => trans['amount']).reduce((a, b) => a + b, 0);
        
        const sumResult = await rdsClient.selectQuery('select sum(amount), count(*) from ledger_3', []);
        expect(sumResult[0]['sum']).to.equal(sumOfAmounts);
        expect(sumResult[0]['count']).to.equal(bigBatchTransactions[0].length);
    });

    it('Run an update, single, and check results', async () => {
        const account = await createBunchOfAccounts(1);
        const accountId = account.rows[0]['id'];

        await createLedgerTable('update_ledger');
        const transId = await rdsClient.insertRecords(`insert into update_ledger (account_id, amount) values $1 returning id`, 
            { 'account_id': accountId, 'amount': 1432 });
        
        const updateLedgerResult = await rdsClient.updateRecord('update update_ledger set amount = $1 where id = $2', [ 2431, transId ]);
        
        expect(updateLedgerResult).to.exist;
        
        const selectRow = await rdsClient.selectQuery('select amount from update_ledger where id = $1', [transId]);
        expect(selectRow).to.exist;
        expect(selectRow[0]['amount']).to.equal(2431);
    });

    it('Handle connection releasing', async () => {
        const haveConnection = rdsClient.connectionPresent();
        if (!haveConnection) {
            await rdsClient.connect();
        }

        await rdsClient.endConnect();
        const revisedConnectionPresent = rdsClient.connectionPresent();
        expect(revisedConnectionPresent).to.be.false;

    });

    const createBunchOfAccounts = async (numAccounts) => {
        const accountNames = randomWords(numAccounts);
        const query = 'insert into account (name) values $1 returning id';
        const values = accountNames.map((word) => ({ name: word }));
        if (numAccounts < 5) {
            logger('Value list: ', values);
        }
        return await rdsClient.insertRecords(query, values);
    };

    const insertBatchOfRecords = async (numRecordsPerAccount, referenceAmount, accounts) => {
        let accountIds;
        if (!accounts) {
            const idQueryFetch = await rdsClient.selectQuery('SELECT id FROM account', []);
            accountIds = idQueryFetch.map(row => row['id']);
        } else  {
            accountIds = accounts;
        }

        var transValues = Array.from({ length: numRecordsPerAccount}, 
            () => accountIds.map(id => ({ account_id: id, amount: Math.floor(Math.random() * referenceAmount)})));
        // logger('Trans values: ', transValues);
        return transValues;
    }

    const sumForAccount = (transactionBatches, accountId) => {
        const extractedAccountAmounts = transactionBatches
            .map(batch => batch.filter(trans => trans['account_id'] == accountId).map(trans => trans['amount']));
        const sumOfAmounts = extractedAccountAmounts.map(amount => amount[0]).reduce((a, b) => a + b, 0);
        return sumOfAmounts;
    }

});