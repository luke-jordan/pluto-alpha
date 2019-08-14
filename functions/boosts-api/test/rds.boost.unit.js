'use strict';

const logger = require('debug')('jupiter:boosts:rds-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');
const decamelize = require('decamelize');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const proxyquire = require('proxyquire');

const queryStub = sinon.stub();
const insertStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();

const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.insertRecords = insertStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const rds = proxyquire('../persistence/rds.boost', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(queryStub, insertStub, multiTableStub, multiOpStub);

describe('*** UNIT TEST BOOSTS RDS *** Inserting boost instruction and boost-user records', () => {

    const testBoostId = uuid();

    const accountTable = config.get('tables.accountLedger');
    const boostTable = config.get('tables.boostTable');
    const boostUserTable = config.get('tables.boostAccountJoinTable');

    const audienceQueryBase = `select account_id from ${accountTable}`;

    const standardBoostKeys = ['boostId', 'startTime', 'endTime', 'boostType', 'boostCategory', 'boostAmount', 'boostUnit', 'boostCurrency', 
        'fromBonusPoolId', 'forClientId', 'boostAudience', 'audienceSelection', 'conditionClause'];
    const boostUserKeys = ['boostId', 'accountId', 'status'];
    
    const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
    const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

    beforeEach(() => (resetStubs()));

    it('Insert a referral code and construct the two entry logs', async () => {

        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testReferringAccountId = uuid();
        const testReferredUserAccountId = uuid();
        const relevantUsers = [testReferringAccountId, testReferredUserAccountId];

        logger('Here we go');

        // first, obtain the audience & generate a UID
        const expectedSelectQuery = `${audienceQueryBase} where account_id in ($1, $2)`;
        queryStub.withArgs(expectedSelectQuery, sinon.match(relevantUsers)).resolves([ 
            { 'account_id': testReferringAccountId }, { 'account_id': testReferredUserAccountId }
        ]);

        uuidStub.onFirstCall().returns(testBoostId);

        // then, construct the simultaneous insert operations
        // first, the instruction to insert the overall boost
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(standardBoostKeys)}) values %L returning boost_id, creation_time`;
        const expectedFirstRow = {
            boostId: testBoostId,
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            boostAudience: 'INDIVIDUAL',
            audienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
            conditionClause: `save_completed_by #{${testReferredUserAccountId}}`
        };
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: extractColumnTemplate(standardBoostKeys), rows: [expectedFirstRow]};

        // then, the instruction for the user - boost join entries
        const expectedSecondQuery = `insert into ${boostUserTable} (${extractQueryClause(boostUserKeys)}) values %L returning insertion_id, creation_time`;
        const expectedJoinTableRows = [
            { boostId: testBoostId, accountId: testReferringAccountId, status: 'PENDING' },
            { boostId: testBoostId, accountId: testReferredUserAccountId, status: 'PENDING' }
        ];
        const expectedSecondDef = { query: expectedSecondQuery, columnTemplate: extractColumnTemplate(boostUserKeys), rows: expectedJoinTableRows};

        // then transact them
        const insertionTime = moment();
        multiTableStub.withArgs([insertFirstDef, expectedSecondDef]).resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }],
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const testInstruction = {
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            conditionClause: `save_completed_by #{${testReferredUserAccountId}}`,
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: `whole_universe from #{ {"specific_accounts": ["${testReferringAccountId}","${testReferredUserAccountId}"]} }`,
            defaultStatus: 'PENDING'
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);

        // then respond with the number of users, and the boost ID itself, along with when it was persisted (given psql limitations, to nearest second)
        const expectedMillis = insertionTime.startOf('second').valueOf();
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('boostId', testBoostId);
        expect(resultOfInsertion).to.have.property('persistedTimeMillis', expectedMillis);
        expect(resultOfInsertion).to.have.property('numberOfUsersEligible', relevantUsers.length);
    });

});

// describe('*** UNIT TEST BOOSTS RDS *** Unit test recording boost-user responses / logs', () => {

// });